-- 0006：T1/T2 里程碑时间戳（TP-4-14，设计稿 21.2 措施一）
--
-- ── R-34：21.2 要求写里程碑时间戳，而 generation_jobs 没有地方放 ──
--
-- 21.2 措施一的末尾：「对应地，`generation_jobs` 在 T1、T2 各写一个里程碑
-- 时间戳，客户端据此提前展示，而不是等 `status === 'COMPLETED'`」。
-- 但十五章的建表 SQL 里没有这两列。
--
-- 唯一形似的是 `stage_timings JSONB`，而十五章明确它是「每阶段**耗时毫秒数**」
-- —— 那是给 21.3 的直方图用的，语义是 duration 而不是 timestamp。
-- 把里程碑塞进去有两个具体问题：
--   1. 同一列里混着「耗时」与「时刻」两种量纲，读的人必须逐键分辨；
--   2. JSONB 里的时刻无法建索引，而「T1 P95 是否 < 75 秒」这类查询
--      （21.3 的 SLA 告警）需要按时间范围扫。
--
-- 因此补两列。T3 不需要新列：它是「PNG/PDF 全部导出完成」，
-- 而那个时刻就是 `exports.finished_at`（每个导出任务一行，天然可查）。
--
-- ── 为什么不是 NOT NULL ──
--
-- T1 在 SAVING_PLAN 完成时写，T2 在 RESOLVING_ASSETS 完成时写。
-- 一个在 GENERATING_PLAN 就失败的任务永远不会有 T1 —— 而那是正常的。
-- 用 NOT NULL + 默认值会让「没到过那个里程碑」与「刚好在建行那一刻到达」
-- 无法区分，SLA 统计会把全部失败任务算成 T1 = 0 秒。

ALTER TABLE generation_jobs
    ADD COLUMN t1_at TIMESTAMPTZ,
    ADD COLUMN t2_at TIMESTAMPTZ;

COMMENT ON COLUMN generation_jobs.t1_at IS
    'T1 计划可读：SAVING_PLAN 完成时刻（21.2，P95 < 75 秒）';
COMMENT ON COLUMN generation_jobs.t2_at IS
    'T2 页面可看：RESOLVING_ASSETS 完成、13.4 可读时刻（21.2，P95 < 110 秒）';

-- 21.3 的 SLA 告警按「最近 15 分钟的 T1 分位数」计算，因此要能按创建时间
-- 扫出一段区间内**已达到 T1** 的任务。部分索引只收有 t1_at 的行 ——
-- 失败任务不参与 SLA 统计（它们的 outcome 由 travel_job_total 统计）。
CREATE INDEX generation_jobs_t1_idx
    ON generation_jobs (created_at DESC)
    WHERE t1_at IS NOT NULL;
