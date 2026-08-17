-- 0005_assets
--
-- 素材与展示表（TP-3-01，设计稿十五章 assets / asset_variants /
-- plan_asset_bindings / plan_presentations，级联按 15.3）。
--
-- ## 两列不在十五章 DDL 里，但缺了它们规则无法落地
--
-- 1. `assets.status`
--    19.3 的失效条件表里，Hero / 景点 / 美食三类的失效条件都写着
--    「人工下架（`assets.status`）」，15.3 也说「素材只标记下架不物理删除
--    （后者是 V1 的做法，见 19.3）」—— 但十五章的建表 SQL 里没有这一列。
--    没有它，加上 `plan_asset_bindings.asset_id` 是 ON DELETE RESTRICT，
--    一张有版权问题的图既不能下架也不能删除，只能一直被检索命中。
--
-- 2. `assets.license_expires_at`
--    19.3 的景点图失效条件是「授权到期（`license` 到期日）」。到期日没有
--    存储位置时，这条规则只能靠人工记住哪批素材什么时候到期。
--    V1 的种子素材都是 PLATFORM_OWNED / CC0（无到期日，列为 NULL），
--    但列必须存在，否则接入授权图源那天要改表 + 回填。
--
-- 两列都进入检索谓词（见 packages/db 的 assets 仓储）：
--   status = 'ACTIVE' AND (license_expires_at IS NULL OR license_expires_at > NOW())
--
-- ## assets 不带 user_id
--
-- 十五章「表关系总览」：assets 与 asset_variants 是**全局共享**的，
-- 跨用户复用是 19.5 缓存策略的前提。它们只存已审核的平台素材与 AI 生成物，
-- 不含任何用户私有内容，因此共享不违反验收标准 11。

-- ── assets ───────────────────────────────────────────────────

CREATE TABLE assets (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),

    asset_type VARCHAR(50) NOT NULL,
    source_type VARCHAR(50) NOT NULL,

    entity_name VARCHAR(200),
    destination_name VARCHAR(200),
    destination_place_id VARCHAR(100),
    title VARCHAR(300),

    original_url TEXT,
    storage_url TEXT NOT NULL,
    thumbnail_url TEXT,

    mime_type VARCHAR(100),
    width INTEGER,
    height INTEGER,
    aspect_ratio NUMERIC(10, 5),

    style_tags JSONB NOT NULL DEFAULT '[]',
    search_text TEXT,

    license_type VARCHAR(50) NOT NULL,
    attribution_text TEXT,
    -- 19.3「授权到期」的存储位置（见文件头）。NULL = 永久授权
    license_expires_at TIMESTAMPTZ,

    quality_score NUMERIC(5, 4),
    embedding VECTOR(1536),

    representation_type VARCHAR(30) NOT NULL DEFAULT 'PHOTOGRAPHIC',
    cache_key TEXT,

    -- 19.3「人工下架」的存储位置（见文件头）
    status VARCHAR(20) NOT NULL DEFAULT 'ACTIVE',

    generation_metadata JSONB,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),

    CONSTRAINT assets_representation_check
        CHECK (representation_type IN ('PHOTOGRAPHIC', 'ILLUSTRATIVE')),
    /*
     * 9.4 / 二十章：AI 生成物不能被当成真实照片。
     *
     * 这条约束下沉到数据库而不是只写在解析器里，理由与 0003 的
     * 「REJECTED 版本不得成为当前版本」相同：把 AI 图标成实拍是**正确性
     * 失败**且没有外部症状 —— 页面上就是一张好看的图，只是「示意图」
     * 三个字没了，而那三个字是我们对用户的全部披露。
     */
    CONSTRAINT assets_ai_must_be_illustrative
        CHECK (source_type <> 'AI_GENERATED' OR representation_type = 'ILLUSTRATIVE'),
    CONSTRAINT assets_status_check CHECK (status IN ('ACTIVE', 'RETIRED')),
    CONSTRAINT assets_type_check CHECK (asset_type IN ('IMAGE', 'SVG', 'ICON')),
    CONSTRAINT assets_source_type_check CHECK (source_type IN (
        'PLATFORM_LIBRARY', 'LICENSED_SOURCE', 'AI_GENERATED',
        'GENERATED_SVG', 'LOCAL_ICON', 'DEFAULT_PLACEHOLDER')),
    CONSTRAINT assets_license_check CHECK (license_type IN (
        'PLATFORM_OWNED', 'LICENSED', 'AI_GENERATED', 'CC0')),
    -- 二十章：AI 生成物的可追溯性（验收标准 12 的判定依据）就是这一列
    CONSTRAINT assets_ai_metadata_check
        CHECK (source_type <> 'AI_GENERATED' OR generation_metadata IS NOT NULL),
    CONSTRAINT assets_quality_range_check
        CHECK (quality_score IS NULL OR (quality_score >= 0 AND quality_score <= 1))
);

-- 19.5：同键全平台只生成一次。部分唯一索引 —— cache_key 为 NULL 的素材
-- （人工灌入的种子图不参与键复用）不受约束
CREATE UNIQUE INDEX assets_cache_key_uk ON assets (cache_key) WHERE cache_key IS NOT NULL;

-- 10.2 第 1 步的 entity/destination 预过滤
CREATE INDEX assets_entity_destination_idx
    ON assets (entity_name, destination_name);

CREATE INDEX assets_embedding_idx
    ON assets USING hnsw (embedding vector_cosine_ops);

/*
 * `simple` 而不是 `chinese`：PostgreSQL 内置分词器没有中文支持，
 * `to_tsvector('chinese', ...)` 在标准镜像上直接报错。中文的词汇召回由
 * search_text 里预先切好的 bigram 承担（见 packages/assets 的 search-text.ts），
 * 这里的 GIN 索引只做「已切分文本」的倒排。
 */
CREATE INDEX assets_search_text_idx
    ON assets USING gin (to_tsvector('simple', coalesce(search_text, '')));

-- 检索只看在架且授权未到期的素材，把这两个谓词一起入索引
CREATE INDEX assets_active_idx
    ON assets (destination_place_id, asset_type)
    WHERE status = 'ACTIVE';

-- ── asset_variants ───────────────────────────────────────────
--
-- 11.2 第 5 步的缩略图等衍生物。原图与衍生物分表而不是在 assets 上加
-- thumbnail_width/height：变体种类会增加（webp/avif、多档宽度），
-- 每种都加两列会让 assets 无限变宽。

CREATE TABLE asset_variants (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    asset_id UUID NOT NULL REFERENCES assets(id) ON DELETE CASCADE,
    variant_type VARCHAR(50) NOT NULL,
    width INTEGER,
    height INTEGER,
    mime_type VARCHAR(100),
    storage_url TEXT NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),

    -- 同一素材的同一变体只应有一行；重复入库说明后处理被跑了两次，
    -- 而两次上传的对象键不同，旧的那份会成为无人引用的垃圾
    CONSTRAINT asset_variants_uk UNIQUE (asset_id, variant_type),
    CONSTRAINT asset_variants_type_check
        CHECK (variant_type IN ('THUMBNAIL', 'ORIGINAL'))
);

-- ── plan_asset_bindings ──────────────────────────────────────

CREATE TABLE plan_asset_bindings (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    plan_id UUID NOT NULL REFERENCES travel_plans(id) ON DELETE CASCADE,
    plan_version_id UUID NOT NULL REFERENCES travel_plan_versions(id) ON DELETE CASCADE,
    -- FULL_PLAN 复用各日素材，不新增槽位（3.3.1），因此绑定永远挂在某一天上。
    -- 允许 NULL 是为计划级槽位留位（V1 没有）
    day_number INTEGER,
    template_id VARCHAR(100) NOT NULL,
    slot_id VARCHAR(200) NOT NULL,
    role VARCHAR(100) NOT NULL,

    /*
     * 15.3：ON DELETE RESTRICT。素材是共享资源，不能因为某个计划被删就
     * 删素材；反过来素材被人工下架时也不能悄悄删掉绑定 ——
     * 绑定是「这张图曾经用在这个计划里」的记录，是二十章可追溯性的一环。
     * 下架用 assets.status，不用 DELETE（见文件头）。
     */
    asset_id UUID NOT NULL REFERENCES assets(id) ON DELETE RESTRICT,

    resolution_strategy VARCHAR(100),
    resolution_score NUMERIC(5, 4),
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),

    -- TP-3-15：重复解析不产生重复绑定。ON CONFLICT DO UPDATE 的冲突目标
    CONSTRAINT plan_asset_bindings_uk UNIQUE (plan_version_id, template_id, slot_id),
    CONSTRAINT plan_asset_bindings_day_check
        CHECK (day_number IS NULL OR day_number BETWEEN 1 AND 14),
    CONSTRAINT plan_asset_bindings_score_check
        CHECK (resolution_score IS NULL
               OR (resolution_score >= 0 AND resolution_score <= 1))
);

CREATE INDEX plan_asset_bindings_version_idx
    ON plan_asset_bindings (plan_version_id, day_number);

-- 下架素材前要先查还有谁在引用它（RESTRICT 会拒绝删除，但需要能列出引用方）
CREATE INDEX plan_asset_bindings_asset_idx ON plan_asset_bindings (asset_id);

-- ── plan_presentations ───────────────────────────────────────

CREATE TABLE plan_presentations (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    plan_id UUID NOT NULL REFERENCES travel_plans(id) ON DELETE CASCADE,
    plan_version_id UUID NOT NULL REFERENCES travel_plan_versions(id) ON DELETE CASCADE,
    template_id VARCHAR(100) NOT NULL,
    page_type VARCHAR(30) NOT NULL DEFAULT 'DAILY_POSTER',
    day_number INTEGER,
    view_model JSONB NOT NULL,
    validation_status VARCHAR(30) NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),

    CONSTRAINT plan_presentations_page_type_check
        CHECK (page_type IN ('DAILY_POSTER', 'FULL_PLAN')),
    -- 3.3.1：page_type 与 day_number 的绑定关系。
    -- TravelPosterViewModelSchema 有同名 refine，两处一致
    CONSTRAINT plan_presentations_day_number_check CHECK (
        (page_type = 'DAILY_POSTER' AND day_number IS NOT NULL)
        OR (page_type = 'FULL_PLAN' AND day_number IS NULL)
    ),
    CONSTRAINT plan_presentations_validation_check
        CHECK (validation_status IN ('VALID', 'DEGRADED', 'INVALID')),
    CONSTRAINT plan_presentations_day_range_check
        CHECK (day_number IS NULL OR day_number BETWEEN 1 AND 14)
);

/*
 * COALESCE(day_number, -1) 让 FULL_PLAN（day_number 为 NULL）也参与唯一性。
 *
 * PostgreSQL 中 NULL 不参与唯一性比较，不做这个处理的话完整计划页可以
 * 重复插入 —— 而 13.4 是按「版本 + 模板 + 页型」取一行，多行时取哪行不确定，
 * 症状是「同一个计划刷新两次看到不同的页面」。
 */
CREATE UNIQUE INDEX plan_presentations_uk
    ON plan_presentations (plan_version_id, template_id, page_type, COALESCE(day_number, -1));

-- 13.4 的取数路径：按版本 + 页型 + 天号
CREATE INDEX plan_presentations_lookup_idx
    ON plan_presentations (plan_version_id, page_type, day_number);
