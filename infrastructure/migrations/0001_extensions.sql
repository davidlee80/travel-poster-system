-- 0001_extensions
--
-- 建立三个必需扩展（设计稿十五章「扩展与约定」、22.3.2）。
--
--   pgcrypto  gen_random_uuid()，全部主键使用
--   vector    pgvector，assets.embedding / travel_plan_versions.plan_embedding
--             / plan_knowledge.embedding 的 VECTOR(1536) 与 HNSW 索引
--   citext    users.email 的大小写不敏感唯一约束
--
-- 这三个扩展决定了后续所有迁移能否执行，因此单独作为 0001。
-- 镜像必须是 pgvector/pgvector:pg17 而非官方 postgres:17 —— 后者不含 vector。
--
-- schema_migration 表由迁移执行器自身创建（packages/db/src/migrate.ts），
-- 不在此声明：它必须先于任何迁移存在。

CREATE EXTENSION IF NOT EXISTS "pgcrypto";
CREATE EXTENSION IF NOT EXISTS "vector";
CREATE EXTENSION IF NOT EXISTS "citext";
