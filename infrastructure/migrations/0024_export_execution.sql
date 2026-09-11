-- 存量导出保持旧协议，不自动重放或补账。
ALTER TABLE exports
  ADD COLUMN execution_token uuid,
  ADD COLUMN execution_expires_at timestamptz,
  ADD COLUMN execution_protocol smallint NOT NULL DEFAULT 0,
  ADD COLUMN attempt_count integer NOT NULL DEFAULT 0,
  ADD COLUMN finalization_pending boolean NOT NULL DEFAULT false,
  ADD CONSTRAINT export_execution_lease_shape CHECK
    ((execution_token IS NULL) = (execution_expires_at IS NULL));
ALTER TABLE exports ALTER COLUMN execution_protocol SET DEFAULT 1;
CREATE INDEX export_finalization_pending_idx ON exports (id) WHERE finalization_pending;
