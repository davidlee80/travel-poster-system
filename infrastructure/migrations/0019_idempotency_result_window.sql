-- 13.8 的「幂等结果有效期 7 天」落地。
--
-- ## 这条规则此前只是一个常量
--
-- `IDEMPOTENCY_RESULT_TTL_DAYS = 7`（packages/shared/src/idempotency.ts）被定义、
-- 被导出、还有一条测试断言它等于 7 —— 而没有任何 SQL 用过它。
-- 仓储甚至已经在 `SELECT r.created_at` 并把它作为 `createdAt` 返回，
-- 而路由从不读那个值：这说明窗口是设计好然后掉了，不是刻意省略。
--
-- 常量注释自己写了后果：「否则用户想『重新生成』时会被永久锁死在旧结果上」。
--
-- ## 为什么光加一个 `created_at >` 谓词不够
--
-- 那样只让**查询**忽略旧行，而 `travel_requests_idempotency_uk` 是**全局**
-- 唯一约束 —— 插入照样撞索引，抛 `UniqueViolationError`，然后路由的兜底分支
-- 回查（同样带窗口，查不到）→ 返回 `SYS_INTERNAL_ERROR`。
-- 用户拿到的从「锁死在旧结果」变成 500，更糟。
--
-- ## 为什么不能把时间谓词写进索引
--
-- `WHERE created_at > now() - interval '7 days'` 不可用：索引谓词必须是
-- IMMUTABLE 的，而 `now()` 不是。因此时间判定只能留在查询侧，
-- 索引侧改用一个由应用翻转的标志位 —— 与迁移 0018 的导出幂等同一手法。
--
-- ## 形状
--
-- `superseded_at IS NULL` 的行参与唯一性；超过 7 天的旧行在下一次同键请求
-- 落库时被就地标记（与 INSERT 同一事务，见 packages/db 的 createGeneration）。
-- 标记而不是删行：`raw_request` 与那次生成的全部产物都挂在它下面，
-- 而 15.1 的保留策略管着它们的寿命，不该由幂等窗口顺手删掉。

ALTER TABLE travel_requests ADD COLUMN superseded_at TIMESTAMPTZ;

COMMENT ON COLUMN travel_requests.superseded_at IS
    '13.8 幂等窗口：非空表示该行已被同键的新请求取代，不再参与唯一性判定';

ALTER TABLE travel_requests DROP CONSTRAINT travel_requests_idempotency_uk;

/*
 * 13.8 幂等的最终真相源仍然是这条索引，只是范围收窄到「未被取代的行」。
 *
 * 同一个键因此可以有多行历史 + 最多一行活跃记录 —— 按键回查时必须同时带
 * `superseded_at IS NULL` 与 7 天窗口，两处谓词缺一个都会读到不该读的行。
 */
CREATE UNIQUE INDEX travel_requests_idempotency_uk
    ON travel_requests (idempotency_key)
    WHERE superseded_at IS NULL;

COMMENT ON INDEX travel_requests_idempotency_uk IS
    '13.8 的生成幂等键。排除已取代的行，让超过 7 天的同键请求能作为新任务落库';

/*
 * 取代旧行时要按键定位它，而上面那条部分索引只覆盖 superseded_at IS NULL
 * 的行 —— 它正好能服务那次 UPDATE 的谓词，因此不需要额外索引。
 * 这条注释存在是为了说明「为什么没有为 superseded_at 建索引」。
 */
