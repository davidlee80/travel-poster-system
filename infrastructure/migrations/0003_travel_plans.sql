-- 0003_travel_plans
--
-- 业务主干表（TP-2-01、TP-2-02，设计稿十五章、15.2、15.3）。
--
-- 建表时就带 user_id NOT NULL：P1 已交付 users 表与身份中间件，因此不存在
-- 「先无归属、后补归属」的中间态。补归属的迁移必须处理「已有行归谁」，
-- 而那个问题没有正确答案。
--
-- ## R-17：travel_plan_versions 冗余两列
--
-- 15.2 要求全局检索走只读角色 travel_retrieval_ro，只授予
-- travel_plan_versions 的少数列 + plan_knowledge。但 3.2.4 的检索条件包含
-- 「同 place_id」与「total_days ±3」，而这两个值原本只在 travel_plans 上 ——
-- 该角色没有 travel_plans 的任何权限，**join 不到**，隔离设计因此不可实现。
--
-- 解法是把这两列冗余到版本表：它们不是个人数据（目的地与天数），
-- 冗余后检索成为单表查询，列级 GRANT 才真正够用。
-- 这也让版本表与 plan_knowledge 的形状一致 —— 后者正是
-- (destination_place_id, total_days, projection, embedding)。
--
-- ## 级联按 15.3 逐条声明
--
-- 十五章的建表 SQL 里写的是裸 REFERENCES，15.3 才补上 ON DELETE 行为。
-- 以 15.3 为准：15.1 的保留期清理**依赖级联**，缺一条就会在删 users 行时
-- 报外键冲突，而清理任务是后台批处理，报错只会留在日志里。

-- ── travel_requests ──────────────────────────────────────────
--
-- raw_request 保存原始 TravelRequestUI，normalized_request 保存
-- NormalizedTravelRequest（3.1）。两者都留是为了在标准化规则变更后，
-- 能用原始输入重放 —— 只存标准化结果的话，规则改了就再也无法复现旧行为。

CREATE TABLE travel_requests (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,

    client_request_id VARCHAR(100) NOT NULL,
    idempotency_key CHAR(64) NOT NULL,

    raw_request JSONB NOT NULL,
    normalized_request JSONB NOT NULL,

    destination_name VARCHAR(200) NOT NULL,
    destination_place_id VARCHAR(100),
    start_date DATE NOT NULL,
    end_date DATE NOT NULL,
    total_days INTEGER NOT NULL,
    traveler_count INTEGER NOT NULL,

    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),

    -- 13.8 幂等的最终真相源。Redis 的 SETNX 只是快路径，Redis 挂了
    -- 或键过期时，这条唯一约束仍然保证同键只落一行
    CONSTRAINT travel_requests_idempotency_uk UNIQUE (idempotency_key),
    CONSTRAINT travel_requests_days_check CHECK (total_days BETWEEN 1 AND 14),
    CONSTRAINT travel_requests_dates_check CHECK (end_date >= start_date),
    CONSTRAINT travel_requests_travelers_check CHECK (traveler_count >= 1),
    -- total_days 必须与日期区间一致（含首尾两端）。两者不一致时后续每一步
    -- 都会按不同的天数工作，而症状是「第 8 天渲染失败」这类离根因很远的报错
    CONSTRAINT travel_requests_days_match_check
        CHECK (total_days = (end_date - start_date) + 1)
);

CREATE INDEX travel_requests_user_created_idx
    ON travel_requests (user_id, created_at DESC);

-- ── travel_plans ─────────────────────────────────────────────

CREATE TABLE travel_plans (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    request_id UUID NOT NULL REFERENCES travel_requests(id) ON DELETE CASCADE,

    title VARCHAR(300),
    destination_name VARCHAR(200) NOT NULL,
    start_date DATE NOT NULL,
    total_days INTEGER NOT NULL,

    -- 外键在下方单独添加：与 travel_plan_versions 互相引用，
    -- 建表顺序上此刻目标表还不存在
    current_version_id UUID,

    status VARCHAR(30) NOT NULL DEFAULT 'GENERATING',

    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),

    CONSTRAINT travel_plans_status_check
        CHECK (status IN ('GENERATING', 'READY', 'FAILED', 'ARCHIVED')),
    CONSTRAINT travel_plans_days_check CHECK (total_days BETWEEN 1 AND 14)
);

CREATE INDEX travel_plans_user_created_idx
    ON travel_plans (user_id, created_at DESC);

-- ── travel_plan_versions ─────────────────────────────────────

CREATE TABLE travel_plan_versions (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    plan_id UUID NOT NULL REFERENCES travel_plans(id) ON DELETE CASCADE,
    version_number INTEGER NOT NULL,

    status VARCHAR(30) NOT NULL,
    plan_json JSONB NOT NULL,
    constraint_report JSONB NOT NULL DEFAULT '{}',

    -- R-13：3.2.4 的脱敏投影，全局历史检索只读这一列
    retrieval_projection JSONB NOT NULL,

    -- R-17：冗余自 travel_plans，让检索成为单表查询（见文件头说明）
    destination_place_id VARCHAR(100),
    total_days INTEGER NOT NULL,

    llm_model VARCHAR(100),
    llm_prompt_version VARCHAR(50),
    input_tokens INTEGER,
    output_tokens INTEGER,
    repair_iterations INTEGER NOT NULL DEFAULT 0,
    regeneration_count INTEGER NOT NULL DEFAULT 0,

    plan_embedding VECTOR(1536),

    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),

    CONSTRAINT travel_plan_versions_uk UNIQUE (plan_id, version_number),
    CONSTRAINT travel_plan_versions_status_check
        CHECK (status IN ('READY', 'REPAIRED', 'REJECTED')),
    CONSTRAINT travel_plan_versions_version_check CHECK (version_number >= 1),
    CONSTRAINT travel_plan_versions_days_check CHECK (total_days BETWEEN 1 AND 14),
    -- 3.2.2 的迭代上限：程序化修复 ≤ 3 轮、LLM 重生成 ≤ 2 次。
    -- 落库时超限说明循环没被上限拦住，那是死循环风险，必须在写入处暴露
    CONSTRAINT travel_plan_versions_repair_check
        CHECK (repair_iterations BETWEEN 0 AND 3),
    CONSTRAINT travel_plan_versions_regeneration_check
        CHECK (regeneration_count BETWEEN 0 AND 2)
);

CREATE INDEX travel_plan_versions_plan_idx
    ON travel_plan_versions (plan_id, version_number DESC);

CREATE INDEX travel_plan_versions_embedding_idx
    ON travel_plan_versions USING hnsw (plan_embedding vector_cosine_ops);

-- R-13：全局检索的过滤维度（不带 user_id，跨用户跨身份，见 3.2.4）。
-- 带上 R-17 的两列，让 3.2.4 的「同 place_id + total_days ±3」直接走索引
CREATE INDEX travel_plan_versions_retrieval_idx
    ON travel_plan_versions (destination_place_id, total_days)
    WHERE status IN ('READY', 'REPAIRED');

-- ── travel_plans.current_version_id 的外键 ───────────────────
--
-- DEFERRABLE INITIALLY DEFERRED 是这里的关键。
--
-- 两张表互相引用（plans → 当前版本，versions → 所属计划），非延迟外键下
-- 无论先插哪张都会违反约束。十五章为此选择「不加外键，由应用维护」——
-- 但那样一来「current_version_id 指向不存在的版本」就成了可能状态，
-- 而它的表现是查询计划时 join 不到内容、页面空白。
--
-- 延迟外键把检查推到事务提交时，既允许事务内的循环写入，又保证提交后
-- 指针一定有效。这是 Postgres 为这类场景提供的正确工具。
ALTER TABLE travel_plans
    ADD CONSTRAINT travel_plans_current_version_fk
    FOREIGN KEY (current_version_id) REFERENCES travel_plan_versions(id)
    ON DELETE SET NULL
    DEFERRABLE INITIALLY DEFERRED;

-- ── REJECTED 版本不得成为 current_version_id ─────────────────
--
-- 验收标准 15：REJECTED 版本落库仅供排查，永不对外可见。
--
-- 为什么用触发器而不是只靠仓储层：把校验失败的计划展示给用户是**正确性
-- 失败**，而它没有任何外部症状 —— 用户看到的是一份完整的计划，只是内容
-- 违反了业务规则（比如预算与明细不符、时间重叠）。
-- 这类不变式不该由「只有一个写入方」这种纪律保证。
--
-- 与 users 表的三个 shape 约束同一思路：能下沉到数据库的正确性就下沉。
CREATE FUNCTION travel_plans_reject_rejected_version() RETURNS TRIGGER AS $$
DECLARE
    version_status VARCHAR(30);
    version_plan_id UUID;
BEGIN
    IF NEW.current_version_id IS NULL THEN
        RETURN NEW;
    END IF;

    SELECT status, plan_id INTO version_status, version_plan_id
    FROM travel_plan_versions
    WHERE id = NEW.current_version_id;

    -- 延迟外键下，插入时目标版本可能还没写入。此时放行 ——
    -- 提交时外键会保证它存在，而版本行一旦存在，状态就不会再变成 REJECTED
    -- （版本是不可变的，修复产生新版本而不是改旧版本）
    IF version_status IS NULL THEN
        RETURN NEW;
    END IF;

    IF version_status = 'REJECTED' THEN
        RAISE EXCEPTION
            'current_version_id % 指向 REJECTED 版本，违反验收标准 15',
            NEW.current_version_id;
    END IF;

    IF version_plan_id <> NEW.id THEN
        RAISE EXCEPTION
            'current_version_id % 属于计划 %，不属于计划 %',
            NEW.current_version_id, version_plan_id, NEW.id;
    END IF;

    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER travel_plans_current_version_guard
    BEFORE INSERT OR UPDATE OF current_version_id ON travel_plans
    FOR EACH ROW EXECUTE FUNCTION travel_plans_reject_rejected_version();

-- ── generation_jobs ──────────────────────────────────────────

CREATE TABLE generation_jobs (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    request_id UUID NOT NULL REFERENCES travel_requests(id) ON DELETE CASCADE,
    plan_id UUID REFERENCES travel_plans(id) ON DELETE CASCADE,
    plan_version_id UUID REFERENCES travel_plan_versions(id) ON DELETE CASCADE,

    status VARCHAR(40) NOT NULL DEFAULT 'QUEUED',
    progress SMALLINT NOT NULL DEFAULT 0,
    message TEXT,

    error_code VARCHAR(60),
    error_detail JSONB,
    warnings JSONB NOT NULL DEFAULT '[]',

    attempt_count INTEGER NOT NULL DEFAULT 0,
    queue_job_id VARCHAR(100),

    started_at TIMESTAMPTZ,
    finished_at TIMESTAMPTZ,
    stage_timings JSONB NOT NULL DEFAULT '{}',

    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),

    CONSTRAINT generation_jobs_progress_check CHECK (progress BETWEEN 0 AND 100),
    -- 十五章的建表 SQL 没有 status 约束，但 16.1 给出了完整状态集。
    -- 不约束的话拼错的状态名会静默落库，而状态机的下一步是查表驱动的 ——
    -- 症状是任务卡在某个不存在的状态上，既不前进也不失败
    CONSTRAINT generation_jobs_status_check CHECK (status IN (
        'QUEUED',
        'NORMALIZING',
        'VALIDATING_REQUEST',
        'RETRIEVING_REFERENCES',
        'GENERATING_PLAN',
        'VALIDATING_PLAN',
        'REPAIRING_PLAN',
        'SAVING_PLAN',
        'BUILDING_PRESENTATION',
        'RESOLVING_ASSETS',
        'GENERATING_ASSETS',
        'RENDERING_HTML',
        'EXPORTING_PNG',
        'EXPORTING_PDF',
        'COMPLETED',
        'FAILED',
        'CANCELLED'
    )),
    -- 终态必须有结束时间，非终态必须没有。两者不一致会让 21.1 的耗时统计
    -- 悄悄算错 —— 而统计错误不会有人报告
    CONSTRAINT generation_jobs_finished_shape_check CHECK (
        (status IN ('COMPLETED', 'FAILED', 'CANCELLED') AND finished_at IS NOT NULL)
        OR (status NOT IN ('COMPLETED', 'FAILED', 'CANCELLED') AND finished_at IS NULL)
    ),
    -- FAILED 必须带错误码：没有错误码的失败任务无法归类，21.3 的
    -- 失败率按 error_code 分组，缺码的行会整体消失在统计之外
    CONSTRAINT generation_jobs_error_shape_check CHECK (
        (status = 'FAILED' AND error_code IS NOT NULL)
        OR (status <> 'FAILED')
    )
);

CREATE INDEX generation_jobs_user_created_idx
    ON generation_jobs (user_id, created_at DESC);

CREATE INDEX generation_jobs_active_idx
    ON generation_jobs (status)
    WHERE status NOT IN ('COMPLETED', 'FAILED', 'CANCELLED');

-- ── exports ──────────────────────────────────────────────────

CREATE TABLE exports (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    plan_id UUID NOT NULL REFERENCES travel_plans(id) ON DELETE CASCADE,
    plan_version_id UUID NOT NULL REFERENCES travel_plan_versions(id) ON DELETE CASCADE,

    template_id VARCHAR(100) NOT NULL,
    format VARCHAR(10) NOT NULL,
    scope VARCHAR(20) NOT NULL,
    day_numbers INTEGER[],

    idempotency_key CHAR(64) NOT NULL,

    status VARCHAR(20) NOT NULL DEFAULT 'QUEUED',
    progress SMALLINT NOT NULL DEFAULT 0,
    files JSONB NOT NULL DEFAULT '[]',

    error_code VARCHAR(60),
    error_detail JSONB,

    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    finished_at TIMESTAMPTZ,

    CONSTRAINT exports_idempotency_uk UNIQUE (idempotency_key),
    CONSTRAINT exports_format_check CHECK (format IN ('PNG', 'PDF')),
    CONSTRAINT exports_scope_check CHECK (scope IN ('ALL_DAYS', 'SINGLE_DAY', 'FULL_PLAN')),
    CONSTRAINT exports_status_check
        CHECK (status IN ('QUEUED', 'RENDERING', 'COMPLETED', 'PARTIAL', 'FAILED')),
    CONSTRAINT exports_progress_check CHECK (progress BETWEEN 0 AND 100),
    -- 13.5 的参数约束下沉到数据库层。
    --
    -- R-18：十五章原写法有三值逻辑漏洞，**恰好漏掉最重要的一种脏数据**：
    --
    --   (scope = 'SINGLE_DAY' AND array_length(day_numbers, 1) = 1)
    --   OR (scope <> 'SINGLE_DAY' AND day_numbers IS NULL)
    --
    -- 当 scope = 'SINGLE_DAY' 且 day_numbers IS NULL 时：
    --   左支 array_length(NULL, 1) = 1 求值为 NULL，TRUE AND NULL → NULL；
    --   右支 'SINGLE_DAY' <> 'SINGLE_DAY' → FALSE；
    --   NULL OR FALSE → NULL —— 而 Postgres 把 NULL 视为**满足** CHECK。
    --
    -- 于是「单日导出没说是哪一天」这条脏数据可以落库，而渲染 Worker
    -- 拿不到天号，表现是导出失败或静默导出第 1 天。
    --
    -- 改用 CASE（分支完备，无 NULL 传播）+ cardinality（空数组返回 0
    -- 而不是 NULL，array_length 对空数组同样返回 NULL）。
    CONSTRAINT exports_day_numbers_check CHECK (
        CASE scope
            WHEN 'SINGLE_DAY' THEN day_numbers IS NOT NULL AND cardinality(day_numbers) = 1
            ELSE day_numbers IS NULL
        END
    )
);

CREATE INDEX exports_plan_version_idx ON exports (plan_version_id);
CREATE INDEX exports_user_created_idx ON exports (user_id, created_at DESC);

-- ── plan_knowledge ───────────────────────────────────────────
--
-- 二十章：匿名计划过保留期被清理时，其脱敏投影转存到这里。
-- 不含 user_id、日期、金额、人员构成，因此不是个人数据 ——
-- 被清理掉的是「谁在什么时候要去哪」，保留下来的是
-- 「杭州运河主题 5 天可以这样安排」。

CREATE TABLE plan_knowledge (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    destination_place_id VARCHAR(100) NOT NULL,
    total_days INTEGER NOT NULL,
    projection JSONB NOT NULL,
    embedding VECTOR(1536) NOT NULL,
    source_status VARCHAR(30) NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),

    CONSTRAINT plan_knowledge_days_check CHECK (total_days BETWEEN 1 AND 14),
    -- 只有通过校验的计划值得沉淀为知识；REJECTED 的内容违反业务规则，
    -- 让它参与检索等于把错误的安排推荐给后来的用户
    CONSTRAINT plan_knowledge_source_status_check
        CHECK (source_status IN ('READY', 'REPAIRED'))
);

CREATE INDEX plan_knowledge_destination_idx
    ON plan_knowledge (destination_place_id, total_days);

CREATE INDEX plan_knowledge_embedding_idx
    ON plan_knowledge USING hnsw (embedding vector_cosine_ops);

-- ── 15.2：检索专用只读角色 ───────────────────────────────────
--
-- 列级 GRANT 是投影隔离的最后一道防线：即使应用代码写错，
-- 数据库也会拒绝返回 plan_json。
--
-- NOLOGIN + 由应用角色 SET ROLE 切入：不给它独立口令，避免多一套凭据。
DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'travel_retrieval_ro') THEN
        CREATE ROLE travel_retrieval_ro NOLOGIN;
    END IF;
END
$$;

-- 授予的列就是 3.2.4 检索**实际需要**的全部列，一列不多。
-- plan_json、constraint_report、llm_* 与 token 计数都不在其中
GRANT SELECT (id, plan_id, status, destination_place_id, total_days,
              retrieval_projection, plan_embedding)
    ON travel_plan_versions TO travel_retrieval_ro;

GRANT SELECT ON plan_knowledge TO travel_retrieval_ro;
