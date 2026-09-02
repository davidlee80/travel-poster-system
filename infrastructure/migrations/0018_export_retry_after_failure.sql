-- 失败的导出不再占用幂等键。
--
-- ## 问题
--
-- `exports_idempotency_uk` 是**全局**唯一约束，而 13.5 的幂等键
-- （`computeExportIdempotencyKey`）只由 `plan_version_id | format | scope |
-- day_numbers | template_id` 算出 —— 不含任何 nonce。两者叠加的后果是
-- **一次失败的导出永久占住那个组合**：
--
--   1. 用户点「重试导出」→ 同一个键 → `findByIdempotencyKey` 命中那行
--      FAILED → 路由返回 200 + 旧 export_id → 前端显示的还是那次失败；
--   2. 渲染侧的 `markRendering` 只从 QUEUED 转 RENDERING，因此那一行
--      永远不会再被消费。
--
-- 生成侧不会这样：13.1 的幂等键含 `client_request_id`，客户端每次新的
-- 生成意图都会换一个。导出侧没有这个逃生口 —— 参数一样，键就一样。
--
-- 同一条约束还让另一个故障不可恢复：入队失败时（Redis 抖动）钱已经扣、
-- 行已经建，而那一行卡在 QUEUED 且键被占住。改成部分索引之后，
-- 那条路径可以把行置为 FAILED 来腾出键位（见 apps/api 的导出路由）。
--
-- ## 为什么是部分索引而不是删除失败行
--
-- 删行会丢掉 `error_code` / `error_detail` —— 而「这个用户的导出为什么
-- 一直失败」只能靠它们回答。部分索引让失败行留在库里供排查，
-- 同时不再参与唯一性。
--
-- ## 为什么不把 FAILED 排除在 `findByIdempotencyKey` 之外就够了
--
-- 不够。仓储不返回它，`create` 仍然会撞上唯一约束并抛
-- `UniqueViolationError`，而路由的兜底分支会去查既有任务、查不到
-- （因为查询已经排除 FAILED）然后抛错 —— 用户拿到 500。
-- 两处必须一起改。
--
-- ## 迁移安全性
--
-- 改造前的约束保证了全局唯一，因此现有数据里不存在重复键，
-- 建部分索引不会失败。索引名沿用原约束名：DROP CONSTRAINT 会连带
-- 删掉它的支撑索引，名字随之释放。

ALTER TABLE exports DROP CONSTRAINT exports_idempotency_uk;

/*
 * 只有非 FAILED 的行参与唯一性。
 *
 * 于是同一个键可以有多行 FAILED + 最多一行活跃记录 —— 这正是
 * 「失败可重试」需要的形状。按键回查时必须带同样的谓词，
 * 否则会读到历史失败行（见 packages/db/src/exports.ts）。
 */
CREATE UNIQUE INDEX exports_idempotency_uk
    ON exports (idempotency_key)
    WHERE status <> 'FAILED';

COMMENT ON INDEX exports_idempotency_uk IS
    '13.5 的导出幂等键。排除 FAILED：失败的导出不占用键位，用户可用同一组参数重试';
