-- 目的地必须至少选择一个：退役 Planner V2.1 的「完全没定」选项。
--
-- 不直接修改已经发布的历史版本，否则同一个版本号在不同环境会有不同内容。
-- 从各环境当前发布版本克隆下一版，避免覆盖运营可能在版本 3 之后发布的配置。

DO $$
DECLARE
    source_version INTEGER;
    target_version INTEGER;
    target_id UUID;
BEGIN
    SELECT version INTO source_version
    FROM planner_config_versions
    WHERE status = 'PUBLISHED'
    FOR UPDATE;

    IF source_version IS NULL THEN
        RAISE EXCEPTION 'published planner config not found';
    END IF;

    SELECT COALESCE(MAX(version), 0) + 1 INTO target_version
    FROM planner_config_versions;

    target_id := clone_planner_config(
        source_version,
        target_version,
        '目的地必填：停用 trip.destination_status.UNDECIDED'
    );

    UPDATE planner_config_options AS option
    SET enabled = FALSE
    WHERE option.version_id = target_id
      AND option.field_key = 'trip.destination_status'
      AND option.option_key = 'UNDECIDED';

    PERFORM publish_planner_config(target_version);
END
$$;
