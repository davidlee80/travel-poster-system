-- 用户货币（CR）：钱包、流水、预留、价目表
--
-- ## 为什么钱不能放 Redis
--
-- 现有的 `QuotaGuard` 用 Redis 计数器做配额（`packages/shared/src/identity/quota.ts`），
-- 那是对的：配额丢了就丢了，下一个时间窗自动重置，损失是「某个用户多生成了一次」。
-- 钱不一样 —— Redis 没有持久化保证（AOF 也有窗口），一次重启丢掉的是用户充的钱。
-- 因此钱包全在 Postgres，且余额变动与流水写入必须在同一个事务里。
--
-- ## 三张表的分工
--
--   credit_wallets   当前余额与冻结额。**可变**，是唯一的「现在有多少钱」
--   credit_ledger    只追加的流水。**不可变**，是「钱怎么变成现在这样」
--   credit_holds     生成任务的预留。介于两者之间，有状态机
--
-- 余额本可以由流水求和得出（事件溯源），但那让「查余额」变成一次全表聚合，
-- 而余额在每次生成请求的关键路径上。因此保留一列可变余额，
-- 由 `balance_after_cr` 让流水能自校验（任何一行的 after = 上一行 after + amount）。
--
-- ## 为什么预留是独立一张表而不是钱包上的一列
--
-- 一个用户可以同时有多个在跑的生成任务（配额允许每分钟 3 次）。
-- 单列存不下多笔预留，而「哪一笔属于哪个任务」正是结算时必须知道的事。
--
-- ## 价目表照 planner_config_* 的形态做
--
-- 迁移 0010～0012 已经建立了「版本化 + 单一发布版 + clone/publish」这套模式，
-- 运营改配置不重启、可回放、可回滚。价格是同一类东西，而且比问卷选项更需要
-- 可回放：三个月后对账要能答出「那一单是按哪一版价格结算的」。
--
-- ## 回滚
--
-- 价目表回滚与 planner_config 同一手法，而**那个手法不是一句 publish**：
-- `publish_credit_prices` 只接受 DRAFT，刚被顶下来的版本已是 ARCHIVED。
-- 两步：先把它改回 DRAFT，再发布。见 docs/货币与计费.md。
-- 钱包与流水**不提供回滚** —— 流水是只追加的账，冲销要用一条反向的 ADJUST。

-- ── 钱包 ──────────────────────────────────────────────────

CREATE TABLE credit_wallets (
    user_id     UUID        PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
    -- 可用余额。预留时从这里扣到 held_cr
    balance_cr  BIGINT      NOT NULL DEFAULT 0,
    -- 已预留但未结算。结算时从这里扣，差额退回 balance_cr
    held_cr     BIGINT      NOT NULL DEFAULT 0,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),

    /*
     * 两列都不许为负。
     *
     * 这两条 CHECK 是整套设计的安全网：预留用
     * `UPDATE ... WHERE balance_cr >= $amount` 保证不透支，而万一哪天有人写了
     * 一条绕过那个谓词的语句，CHECK 会让事务失败而不是让余额变成负数。
     * 负余额一旦落库，后续每一次「余额够不够」的判断都是错的。
     */
    CONSTRAINT credit_wallets_balance_check CHECK (balance_cr >= 0),
    CONSTRAINT credit_wallets_held_check CHECK (held_cr >= 0)
);

COMMENT ON TABLE credit_wallets IS
    '用户 CR 钱包。balance_cr 可用、held_cr 已预留未结算。两列均有 >= 0 约束，是不透支的最后一道防线';

CREATE TRIGGER credit_wallets_set_updated_at
    BEFORE UPDATE ON credit_wallets
    FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- ── 流水 ──────────────────────────────────────────────────

CREATE TABLE credit_ledger (
    entry_id         UUID        PRIMARY KEY,
    user_id          UUID        NOT NULL REFERENCES users(id) ON DELETE CASCADE,

    kind             VARCHAR(16) NOT NULL,
    -- 有符号：进账为正，扣费为负。求和即余额，便于对账
    amount_cr        BIGINT      NOT NULL,
    -- 这一笔之后的余额。让流水能自校验，也让展示不必回放全表
    balance_after_cr BIGINT      NOT NULL,

    -- 这一笔因为什么发生。ref_type 为 NULL 的只有运营手工 ADJUST
    ref_type         VARCHAR(16),
    ref_id           VARCHAR(64),

    -- 按哪一版价目表结算的。GRANT / TOPUP / ADJUST 与价格无关，为 NULL
    price_version    INTEGER,

    /*
     * 幂等键。**这是整套设计里最重要的一个约束。**
     *
     * 生成任务会被重投（队列重试、worker 崩溃后接管），结算逻辑因此会被
     * 执行多次。没有这个唯一约束，一次重投就是一次重复扣费 —— 而用户不会
     * 因为「少了 2000 CR」来提工单，他只会觉得这个产品贵。
     *
     * 取值形如 `job:<job_id>` / `export:<idempotency_key>` / `signup:<user_id>`，
     * 由调用方构造，见 packages/db 的 CreditWalletRepository。
     */
    idempotency_key  VARCHAR(128) NOT NULL,

    -- 留给将来的支付网关（本轮不接）。对账时用它回查第三方单号
    payment_ref      VARCHAR(128),

    -- 逐项计费明细（SKU / 用量 / 金额），排查与客诉时用
    metadata         JSONB       NOT NULL DEFAULT '{}',

    created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),

    CONSTRAINT credit_ledger_kind_check CHECK (kind IN (
        'TOPUP',      -- 充值（本轮无网关，仅结构预留）
        'GRANT',      -- 赠送（注册赠送、运营授予）
        'SPEND',      -- 消费（生成结算、导出扣费）
        'REFUND',     -- 退还（预留多退、任务失败全退）
        'WRITE_OFF',  -- 坏账（任务失败时我们实际烧掉的成本，不扣用户）
        'ADJUST'      -- 运营手工冲销
    )),
    CONSTRAINT credit_ledger_idem_uk UNIQUE (idempotency_key),
    /*
     * 方向与 kind 必须一致。写错方向的表现是「退款把余额扣得更少」这种
     * 读起来完全正常、对账时才发现的错。
     *
     * WRITE_OFF 恒为 0：它记的是我们的成本，不动用户余额 ——
     * 金额本身在 metadata 里。写成 0 让「求和 = 余额」这条自校验仍然成立。
     */
    CONSTRAINT credit_ledger_direction_check CHECK (
        (kind IN ('TOPUP', 'GRANT', 'REFUND') AND amount_cr > 0)
        OR (kind = 'SPEND' AND amount_cr <= 0)
        OR (kind = 'WRITE_OFF' AND amount_cr = 0)
        OR (kind = 'ADJUST')
    ),
    CONSTRAINT credit_ledger_balance_check CHECK (balance_after_cr >= 0),
    CONSTRAINT credit_ledger_ref_check CHECK (
        (ref_type IS NULL AND ref_id IS NULL) OR (ref_type IS NOT NULL AND ref_id IS NOT NULL)
    )
);

COMMENT ON TABLE credit_ledger IS
    '只追加的 CR 流水。amount_cr 有符号，求和即余额。idempotency_key 唯一，是任务重投不重复扣费的保证';

/* 用户流水页按时间倒序翻页 */
CREATE INDEX credit_ledger_user_time_idx ON credit_ledger (user_id, created_at DESC);

/* 按业务对象回查（「这个任务扣了多少」）*/
CREATE INDEX credit_ledger_ref_idx ON credit_ledger (ref_type, ref_id)
    WHERE ref_type IS NOT NULL;

-- ── 预留 ──────────────────────────────────────────────────

CREATE TABLE credit_holds (
    hold_id       UUID         PRIMARY KEY,
    user_id       UUID         NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    /*
     * 一个任务只能有一笔预留。唯一约束让「重复入队」在数据库层就被拦住，
     * 而不是靠应用层记得先查一次。
     */
    job_id        UUID         NOT NULL,
    amount_cr     BIGINT       NOT NULL,
    -- 预留时锁定的价目版本。结算必须用同一版，否则中途调价会让用户按新价被扣
    price_version INTEGER      NOT NULL,
    status        VARCHAR(16)  NOT NULL DEFAULT 'ACTIVE',
    /*
     * 过期时间。任务被永久丢弃（worker 崩溃且没有接管）时预留会一直挂着，
     * 而挂着的钱用户既用不了也退不回。清理由 retention-worker 扫这一列。
     */
    expires_at    TIMESTAMPTZ  NOT NULL,
    created_at    TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
    settled_at    TIMESTAMPTZ,

    CONSTRAINT credit_holds_job_uk UNIQUE (job_id),
    CONSTRAINT credit_holds_amount_check CHECK (amount_cr > 0),
    CONSTRAINT credit_holds_status_check CHECK (status IN ('ACTIVE', 'SETTLED', 'RELEASED', 'EXPIRED')),
    /* 终态必须有结算时间，ACTIVE 必须没有 —— 两者不一致时无法判断这笔到底结没结 */
    CONSTRAINT credit_holds_settled_shape CHECK (
        (status = 'ACTIVE' AND settled_at IS NULL) OR (status <> 'ACTIVE' AND settled_at IS NOT NULL)
    )
);

COMMENT ON TABLE credit_holds IS
    '生成任务的 CR 预留。job_id 唯一；price_version 锁定结算用的价目版本，避免中途调价影响已提交的任务';

CREATE INDEX credit_holds_active_expiry_idx ON credit_holds (expires_at)
    WHERE status = 'ACTIVE';

-- ── 价目表 ────────────────────────────────────────────────

CREATE TABLE credit_price_versions (
    id           UUID         PRIMARY KEY DEFAULT gen_random_uuid(),
    version      INTEGER      NOT NULL UNIQUE,
    status       VARCHAR(20)  NOT NULL CHECK (status IN ('DRAFT', 'PUBLISHED', 'ARCHIVED')),
    note         TEXT,
    published_at TIMESTAMPTZ,
    created_at   TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
    updated_at   TIMESTAMPTZ  NOT NULL DEFAULT NOW(),

    CONSTRAINT credit_price_published_shape CHECK (
        (status = 'PUBLISHED' AND published_at IS NOT NULL)
        OR (status <> 'PUBLISHED' AND published_at IS NULL)
    )
);

CREATE UNIQUE INDEX credit_price_one_published_uk
    ON credit_price_versions ((status)) WHERE status = 'PUBLISHED';

CREATE TABLE credit_price_items (
    id          UUID         PRIMARY KEY DEFAULT gen_random_uuid(),
    version_id  UUID         NOT NULL REFERENCES credit_price_versions(id) ON DELETE CASCADE,
    -- `<域>.<项>[:<变体>]`，变体是模型名。`:*` 是该域的兜底价
    sku         VARCHAR(160) NOT NULL,
    unit        VARCHAR(24)  NOT NULL,
    -- 售价，已含毛利。运营定它时算进去，代码里不再乘倍率（避免两个真相源）
    price_cr    BIGINT       NOT NULL,
    note        TEXT,
    created_at  TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
    updated_at  TIMESTAMPTZ  NOT NULL DEFAULT NOW(),

    CONSTRAINT credit_price_items_uk UNIQUE (version_id, sku),
    CONSTRAINT credit_price_items_unit_check
        CHECK (unit IN ('PER_MILLION_TOKENS', 'PER_ITEM', 'PER_JOB')),
    /*
     * 允许 0（免费项，例如把 plan.base_fee 设为 0），但不允许负数 ——
     * 负价会让消费变成进账。
     */
    CONSTRAINT credit_price_items_price_check CHECK (price_cr >= 0)
);

COMMENT ON TABLE credit_price_items IS
    '价目明细。sku 形如 llm.in:<model>，:* 为该域兜底价。price_cr 是含毛利的售价，代码不再乘倍率';

CREATE TRIGGER credit_price_versions_set_updated_at
    BEFORE UPDATE ON credit_price_versions
    FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TRIGGER credit_price_items_set_updated_at
    BEFORE UPDATE ON credit_price_items
    FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- ── clone / publish ───────────────────────────────────────
--
-- 与 planner_config 的两个同名函数逐字同构。刻意不抽公共实现：
-- 两套配置的生命周期无关（改价与改问卷选项不同频、不同人），
-- 而共用一个泛型函数会让「改价目表的行为」与「改问卷的行为」耦在一起。

CREATE OR REPLACE FUNCTION clone_credit_prices(source_version INTEGER, new_version INTEGER, new_note TEXT DEFAULT NULL)
RETURNS UUID AS $$
DECLARE
    source_id UUID;
    target_id UUID;
BEGIN
    SELECT id INTO source_id FROM credit_price_versions WHERE version = source_version;
    IF source_id IS NULL THEN RAISE EXCEPTION 'credit price version % not found', source_version; END IF;

    INSERT INTO credit_price_versions (version, status, note)
    VALUES (new_version, 'DRAFT', new_note) RETURNING id INTO target_id;

    INSERT INTO credit_price_items (version_id, sku, unit, price_cr, note)
    SELECT target_id, sku, unit, price_cr, note
    FROM credit_price_items WHERE version_id = source_id;

    RETURN target_id;
END;
$$ LANGUAGE plpgsql;

CREATE OR REPLACE FUNCTION publish_credit_prices(target_version INTEGER)
RETURNS VOID AS $$
DECLARE
    target_id UUID;
BEGIN
    SELECT id INTO target_id
    FROM credit_price_versions
    WHERE version = target_version AND status = 'DRAFT'
    FOR UPDATE;
    IF target_id IS NULL THEN RAISE EXCEPTION 'draft credit price version % not found', target_version; END IF;

    UPDATE credit_price_versions SET status = 'ARCHIVED', published_at = NULL WHERE status = 'PUBLISHED';
    UPDATE credit_price_versions SET status = 'PUBLISHED', published_at = NOW() WHERE id = target_id;
END;
$$ LANGUAGE plpgsql;

CREATE VIEW credit_prices_current AS
SELECT v.version, v.published_at, i.sku, i.unit, i.price_cr, i.note
FROM credit_price_versions v
JOIN credit_price_items i ON i.version_id = v.id
WHERE v.status = 'PUBLISHED';

COMMENT ON VIEW credit_prices_current IS
    '当前发布版本的价目表。与 planner_config_current 不同，这里没有 enabled 列 —— 价目项不做停用，删掉即不计费';

-- ── 种子价目表版本 1 ──────────────────────────────────────
--
-- 数值是**保守的占位值**，上线前运营必须按真实供应商成本与毛利重新定。
-- 取值口径（CREDIT_CR_PER_CNY 默认 1000，即 1 CR = 0.001 元）：
--
--   llm.in:*  20000 CR/百万 token = 20 元/百万 token
--   llm.out:* 60000 CR/百万 token = 60 元/百万 token
--
-- 兜底价刻意定得比常见模型贵：兜底命中意味着「运营加了模型忘了配价」，
-- 而那时宁可多收一点也不能白送。同时会打 travel_credit_unpriced_total 告警。

WITH v AS (
    INSERT INTO credit_price_versions (version, status, note, published_at)
    VALUES (1, 'PUBLISHED', '初始价目表（占位值，上线前需按真实成本重定）', NOW())
    RETURNING id
)
INSERT INTO credit_price_items (version_id, sku, unit, price_cr, note)
SELECT v.id, seed.sku, seed.unit, seed.price_cr, seed.note
FROM v
CROSS JOIN (VALUES
    ('plan.base_fee',    'PER_JOB',            100::BIGINT, '每次生成的固定服务费'),
    ('llm.in:*',         'PER_MILLION_TOKENS', 20000,       '未登记模型的输入兜底价'),
    ('llm.out:*',        'PER_MILLION_TOKENS', 60000,       '未登记模型的输出兜底价'),
    ('embedding.in:*',   'PER_MILLION_TOKENS', 200,         '嵌入兜底价'),
    ('image.ai_generate','PER_ITEM',           300,         'AI 生成一张图'),
    ('image.search',     'PER_ITEM',           20,          '授权图源搜索一次'),
    ('render.page',      'PER_ITEM',           5,           'HTML → PNG 一页'),
    ('export.png',       'PER_ITEM',           30,          '导出 PNG 一次'),
    ('export.pdf',       'PER_ITEM',           50,          '导出 PDF 一次')
) AS seed(sku, unit, price_cr, note);
