-- 0009：用户分层与模型候选池（多模型 failover 计划的任务 2）
--
-- ── 三样东西 ──
--
--   users.tier_level    整数等级，决定这个用户用哪个候选池
--   model_pools         命名的模型序列（顺序即 failover 顺序）
--   tier_model_pools    tier_level → 池的映射，按区间匹配
--
-- ── 为什么 tier_level 是整数而不是枚举 ──
--
-- 枚举（STANDARD / PLUS / SUBSCRIBER）加一档就要改 CHECK 约束，也就是一次迁移。
-- 而运营插入新档位（「Plus 与订阅之间再加一档」）是常规操作，不该每次都要发版。
--
-- 整数 + 区间匹配让这件事不需要任何数据库改动：给定 tier_level，取
-- `min_tier_level <= level` 中最大的那条映射。于是 tier_level = 15 的用户会自动
-- 落到 10 那一档，直到有人为 15 单独加一条映射。
--
-- 代价是可读性：日志里看到 tier_level=20 要查对照表。这是刻意的取舍 ——
-- 灵活性给运营，可读性由 `pnpm user:tier` 与 `pnpm model:pool` 的输出补。
--
-- ── 为什么 (name, kind) 是复合唯一 ──
--
-- 「付费池」这个概念在文本与图像下的内容完全不同（一边是 gpt-4o 那一类，
-- 一边是图像模型）。让同一个池名在两个 kind 下各有自己的模型序列，
-- 运营配置时说的就是业务语言（「付费用户用付费池」），
-- 而不用记 paid_llm / paid_image 这种拼接出来的名字。
--
-- ── 两张表为空时会怎样：回落到 env，行为与现在完全一致 ──
--
-- **本迁移刻意不插入任何种子数据。** 查询返回空时，调用方回落到
-- `LLM_MODEL` / `IMAGE_MODEL` 的单模型行为。
--
-- 因此这次迁移是纯粹的能力添加，零行为变化：迁移完不配置任何池，
-- 系统跑起来和现在一模一样。整个特性可以渐进启用，回滚也不需要动代码 ——
-- 清空 tier_model_pools 即可。
--
-- ── 空池与「没有配置」是两件事 ──
--
-- `models` 有非空数组约束。空数组的语义会是「这一档不许用 AI」，
-- 而那与「这一档没有配置、走 env 默认」完全不同。允许空数组的话，
-- 两种意图在数据上长得一样，而它们的正确行为相反。
-- 真要表达「不许用 AI」，用 QUOTA_*_AI_HERO=0 那条既有的路。

-- ── users.tier_level ──────────────────────────────────────

ALTER TABLE users
    ADD COLUMN IF NOT EXISTS tier_level INTEGER NOT NULL DEFAULT 0;

COMMENT ON COLUMN users.tier_level IS
    '用户分层等级（整数，越大权限越高）。决定 AI 调用走哪个候选池，见 tier_model_pools。0 = 标准用户';

ALTER TABLE users
    DROP CONSTRAINT IF EXISTS users_tier_level_check;

ALTER TABLE users
    ADD CONSTRAINT users_tier_level_check CHECK (tier_level >= 0);

-- ── model_pools ───────────────────────────────────────────

CREATE TABLE IF NOT EXISTS model_pools (
    pool_id     UUID         PRIMARY KEY,
    name        VARCHAR(64)  NOT NULL,
    kind        VARCHAR(16)  NOT NULL,
    -- 有序数组，顺序即 failover 的尝试顺序
    models      JSONB        NOT NULL,
    -- 运营备注（「这一档只放便宜模型」之类），纯人类可读
    note        TEXT,
    created_at  TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
    updated_at  TIMESTAMPTZ  NOT NULL DEFAULT NOW(),

    CONSTRAINT model_pools_kind_check
        CHECK (kind IN ('LLM', 'IMAGE')),
    CONSTRAINT model_pools_name_kind_key
        UNIQUE (name, kind),
    -- 见文件头：空池与「没有配置」的语义相反，不允许用空数组表达前者
    CONSTRAINT model_pools_models_nonempty
        CHECK (jsonb_typeof(models) = 'array' AND jsonb_array_length(models) > 0)
);

COMMENT ON TABLE model_pools IS
    '模型候选池。models 是有序数组，顺序即 failover 尝试顺序。(name, kind) 唯一：同一个池名在文本与图像下各有内容';

-- ── tier_model_pools ──────────────────────────────────────

CREATE TABLE IF NOT EXISTS tier_model_pools (
    kind            VARCHAR(16) NOT NULL,
    -- 区间下界。匹配时取 min_tier_level <= 用户等级 中最大的那条
    min_tier_level  INTEGER     NOT NULL,
    pool_name       VARCHAR(64) NOT NULL,
    -- NULL = 不限，用满整个池。图像标准档取 1、文本标准档取 3
    max_candidates  INTEGER,
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),

    PRIMARY KEY (kind, min_tier_level),
    CONSTRAINT tier_model_pools_kind_check
        CHECK (kind IN ('LLM', 'IMAGE')),
    CONSTRAINT tier_model_pools_min_tier_check
        CHECK (min_tier_level >= 0),
    CONSTRAINT tier_model_pools_max_candidates_check
        CHECK (max_candidates IS NULL OR max_candidates >= 1),
    -- 复合外键：映射只能指向同 kind 的池，避免把图像池配给文本
    CONSTRAINT tier_model_pools_pool_fkey
        FOREIGN KEY (pool_name, kind) REFERENCES model_pools (name, kind)
);

COMMENT ON TABLE tier_model_pools IS
    'tier_level → 模型池的映射，按区间匹配（取 min_tier_level <= 用户等级 中最大的一条）。两张表为空时调用方回落 env 单模型';

COMMENT ON COLUMN tier_model_pools.max_candidates IS
    '该档允许尝试的候选数上限。NULL = 用满整个池。读取时还会被时延预算截断，见 travel_ai_pool_clamped_total';
