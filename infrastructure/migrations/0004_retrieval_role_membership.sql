-- 0004：检索只读角色的成员资格（设计稿 15.2）
--
-- 0003 建了 travel_retrieval_ro 并授予列级 SELECT，但**没有任何角色能切进去**。
-- `travel_retrieval_ro` 是 NOLOGIN（不给它独立口令，避免多一套凭据），
-- 因此检索路径的用法是「应用角色连上来 → SET LOCAL ROLE travel_retrieval_ro
-- → 查询 → 事务结束自动还原」。而 SET ROLE 要求当前角色是目标角色的成员。
--
-- 缺这一步的表现很有欺骗性：单测全过（不碰数据库），集成测试也可能全过
-- （测试常以超级用户连接，超级用户可以 SET ROLE 到任何角色），
-- 只有生产环境用普通应用角色时才报「permission denied to set role」——
-- 而那时的症状是「历史检索总是超时/无参考」，看起来像数据不足。
--
-- 单独一个迁移而不是改 0003：迁移是前向唯一的，改已应用的文件会触发
-- 校验和漂移检测（见 packages/db/src/migrate.ts）。

DO $$
BEGIN
    -- pg_has_role 对超级用户恒为真，因此超级用户会跳过这一步
    IF NOT pg_has_role(CURRENT_USER, 'travel_retrieval_ro', 'MEMBER') THEN
        EXECUTE format('GRANT travel_retrieval_ro TO %I', CURRENT_USER);
    END IF;
END
$$;
