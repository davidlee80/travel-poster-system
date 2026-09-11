-- 上传前登记精确对象键；发布时同事务移除，未发布产物按尝试清理。
CREATE TABLE export_attempt_artifacts (
  token uuid NOT NULL,
  export_id uuid REFERENCES exports(id) ON DELETE SET NULL,
  storage_key text NOT NULL,
  cleanup_after timestamptz NOT NULL DEFAULT NOW(),
  PRIMARY KEY (token, storage_key)
);
CREATE INDEX export_attempt_cleanup_idx ON export_attempt_artifacts (cleanup_after);
