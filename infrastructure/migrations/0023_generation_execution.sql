-- 仅增加内部恢复协议；存量任务不自动加入恢复或重放。
ALTER TABLE generation_jobs
  ADD COLUMN execution_token uuid,
  ADD COLUMN execution_expires_at timestamptz,
  ADD COLUMN execution_protocol smallint NOT NULL DEFAULT 0,
  ADD COLUMN usage_snapshot jsonb,
  ADD COLUMN presentation_checkpoint jsonb,
  ADD COLUMN finalization_pending boolean NOT NULL DEFAULT false,
  ADD CONSTRAINT generation_execution_lease_shape CHECK
    ((execution_token IS NULL) = (execution_expires_at IS NULL));

ALTER TABLE generation_jobs ALTER COLUMN execution_protocol SET DEFAULT 1;
CREATE INDEX generation_finalization_pending_idx ON generation_jobs (updated_at, id)
  WHERE finalization_pending;
