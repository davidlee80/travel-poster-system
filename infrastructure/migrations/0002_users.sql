-- 0002_users
--
-- 匿名 / 注册双模式用户体系（R-13，设计稿 3.6、十五章）。
--
-- ## 为什么统一一张表而不是独立匿名表
--
-- 匿名用户是本表中 user_type = 'ANONYMOUS' 的行，与注册用户共用同一个
-- user_id。收益：
--
--   * 归属列唯一 —— 业务表只需 user_id NOT NULL，不需要可空外键，
--     也不需要「要么 user_id 要么 anonymous_id」的二选一约束；
--   * 查询路径唯一 —— WHERE user_id = :current 对两类身份完全一致；
--   * **升级零迁移** —— 匿名注册时只填 email/password_hash 并翻转 user_type，
--     user_id 不变，历史计划自动继承，不搬运任何业务行。
--
-- 独立匿名表方案下，「匿名 → 注册」要跨 4 张表迁移归属列，还要处理迁移
-- 中途失败留下的部分继承状态。统一表把这个正确性问题从设计里消除掉了。
--
-- 代价是匿名行会累积，用保留期清理解决（15.1，P4 的 retention-worker）。
--
-- ## 三个 shape 约束
--
-- 把 3.6.1 的身份形态规则下沉到数据库：「匿名行带口令」或「注册行无邮箱」
-- 这类脏数据在写入时就被拒绝，不依赖应用层自觉。身份数据一旦写脏，
-- 后果是鉴权行为不可预测 —— 这是最不该靠代码纪律保证的地方。

CREATE TABLE users (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),

    user_type VARCHAR(20) NOT NULL,

    -- 注册用户专属，匿名用户为 NULL
    email CITEXT,
    password_hash TEXT,
    display_name VARCHAR(100),

    -- 匿名用户专属：令牌哈希，不存原文（设计稿 3.6.5）。
    -- 数据库泄漏时无法据此冒充匿名用户。
    anon_token_hash CHAR(64),
    anon_expires_at TIMESTAMPTZ,
    -- 仅用于 21.4 的匿名创建限速与滥用排查；保留期与匿名行一致，到期随行删除
    created_ip INET,

    locale VARCHAR(20) NOT NULL DEFAULT 'zh-CN',
    timezone VARCHAR(50) NOT NULL DEFAULT 'Asia/Shanghai',

    status VARCHAR(20) NOT NULL DEFAULT 'ACTIVE',
    -- 归并后指向目标用户，保留审计链（13.9.4）
    merged_into UUID REFERENCES users(id) ON DELETE SET NULL,

    -- 配额上限落列而非硬编码，可对个别用户单独调整（21.4）
    daily_plan_quota INTEGER NOT NULL,
    monthly_plan_quota INTEGER NOT NULL,

    upgraded_at TIMESTAMPTZ,
    -- 匿名用户活跃则据此续期 anon_expires_at，避免正在使用的数据被清理
    last_seen_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),

    CONSTRAINT users_type_check
        CHECK (user_type IN ('ANONYMOUS', 'REGISTERED')),
    CONSTRAINT users_status_check
        CHECK (status IN ('ACTIVE', 'SUSPENDED', 'MERGED', 'DELETED')),

    -- 注册用户必须有邮箱与口令
    CONSTRAINT users_registered_shape CHECK (
        user_type <> 'REGISTERED'
        OR (email IS NOT NULL AND password_hash IS NOT NULL)
    ),
    -- 匿名用户不得有邮箱或口令，必须有令牌哈希与过期时间
    CONSTRAINT users_anonymous_shape CHECK (
        user_type <> 'ANONYMOUS'
        OR (email IS NULL AND password_hash IS NULL
            AND anon_token_hash IS NOT NULL AND anon_expires_at IS NOT NULL)
    ),
    -- MERGED 必须指向归并目标，其余状态不得指向
    CONSTRAINT users_merged_shape CHECK (
        (status = 'MERGED' AND merged_into IS NOT NULL)
        OR (status <> 'MERGED' AND merged_into IS NULL)
    ),
    CONSTRAINT users_merged_not_self CHECK (merged_into IS DISTINCT FROM id),

    CONSTRAINT users_quota_positive CHECK (
        daily_plan_quota >= 0 AND monthly_plan_quota >= 0
    )
);

-- 邮箱唯一，但只约束注册用户。
-- 不能用列级 UNIQUE：大量匿名行的 email 为 NULL，虽然 PostgreSQL 允许多个
-- NULL，但部分索引更小、意图更明确。
CREATE UNIQUE INDEX users_email_uk
    ON users (email) WHERE email IS NOT NULL;

-- 匿名令牌查找。同为部分索引，避免为注册行保留无用条目。
CREATE UNIQUE INDEX users_anon_token_uk
    ON users (anon_token_hash) WHERE anon_token_hash IS NOT NULL;

-- 保留期清理扫描（15.1）。只覆盖待清理的候选集。
CREATE INDEX users_anon_expiry_idx
    ON users (anon_expires_at)
    WHERE user_type = 'ANONYMOUS' AND status = 'ACTIVE';

-- updated_at 由触发器维护，避免每处 UPDATE 都要记得带上它
CREATE OR REPLACE FUNCTION set_updated_at()
RETURNS TRIGGER AS $$
BEGIN
    NEW.updated_at = NOW();
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER users_set_updated_at
    BEFORE UPDATE ON users
    FOR EACH ROW
    EXECUTE FUNCTION set_updated_at();
