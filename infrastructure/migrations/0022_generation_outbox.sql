-- 生成接受与投递分离。只持久化业务标识和链路上下文，不复制用户请求。
CREATE TABLE generation_outbox (
  job_id uuid PRIMARY KEY REFERENCES generation_jobs(id) ON DELETE CASCADE,
  trace_context jsonb,
  created_at timestamptz NOT NULL DEFAULT NOW(),
  attempts integer NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  next_attempt_at timestamptz NOT NULL DEFAULT NOW(),
  lease_token uuid,
  lease_expires_at timestamptz,
  delivered_at timestamptz,
  CHECK ((lease_token IS NULL) = (lease_expires_at IS NULL))
);

CREATE INDEX generation_outbox_pending_idx
  ON generation_outbox (next_attempt_at, created_at)
  WHERE delivered_at IS NULL;

-- 不回填旧任务：缺少预留不能证明历史任务是否免费或是否已成功入队。
