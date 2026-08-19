-- 0008：搜索入库图的来源元数据（TP-6-04，设计稿 9.6 的 R-46）
--
-- ── 为什么需要这一列：一处设计缺口 ──
--
-- 9.6 明确要求：「`source_metadata` 对 LICENSED_SOURCE 必填（与
-- `generation_metadata` 对 AI_GENERATED 必填对称）：`provider`、
-- `original_url`、检索词、license 原文与到期日。没有这份元数据，
-- FR-3.4.5 / 验收标准 12「素材可追踪来源」对搜索图就是空话，
-- 版权争议时也无从举证。」
--
-- 而十五章的 `assets` 建表 SQL 里**没有这一列** —— 9.6 引用了一个不存在的
-- 字段。这与 P4 记录的四处缺口同类：「设计里有这个东西，但没有任何东西
-- 能到达它」，且这一处的表现最隐蔽 —— 不加列的话代码只会把元数据写进
-- `generation_metadata`（那一列的 CHECK 只约束 AI 行，写别的进去不会报错），
-- 于是「素材可追踪来源」看起来实现了，实际是把搜索来源伪装成了生成元数据。
--
-- ── 为什么不复用 generation_metadata ──
--
-- 0005 的 `assets_ai_metadata_check` 只写了「AI_GENERATED ⇒ 非空」，
-- 因此技术上可以把来源元数据塞进那一列而不违反任何约束。不这么做的理由是
-- 二十章的披露要求：`generation_metadata` 的语义是「这张图是**怎么生成的**」
-- （模型、种子、提示词版本），而搜索图不是生成的。混在一列里之后，
-- 「库里有多少张 AI 图」这个问题要靠 `source_type` 而不能靠这一列非空来答，
-- 而成本核算与对外披露都在读它。
--
-- ── CHECK 与 AI 那条对称 ──
--
-- `LICENSED_SOURCE ⇒ source_metadata IS NOT NULL`。它拦不住「元数据里少了
-- provider」—— 那一层由 Zod（SourceMetadataSchema）在写入前保证，与
-- AI 侧 `GenerationMetadataSchema.parse` 的分工完全相同：
-- 数据库保证「有」，schema 保证「全」。

ALTER TABLE assets
    ADD COLUMN IF NOT EXISTS source_metadata JSONB;

COMMENT ON COLUMN assets.source_metadata IS
    '搜索入库图的来源元数据（9.6 / R-46）：provider、original_url、检索词、license 原文与到期日。LICENSED_SOURCE 必填';

ALTER TABLE assets
    DROP CONSTRAINT IF EXISTS assets_licensed_source_metadata_check;

ALTER TABLE assets
    ADD CONSTRAINT assets_licensed_source_metadata_check
        CHECK (source_type <> 'LICENSED_SOURCE' OR source_metadata IS NOT NULL);
