-- 模板样式目录：把可选的样式套件登记进配置中心（R-85 P3）。
--
-- ## 为什么复用 planner_config_options 而不建新表
--
-- 这张表的形状（field_key / option_key / label / metadata / enabled / sort_order）
-- 正好是「模板目录」需要的全部列，而 `GET /api/v1/planner/config` 已在服务它
-- 并带 ETag 与缓存头，前端也已经在消费那个端点。
--
-- 复用因此白拿三件事：
--   1. label 与示例图地址运营可改，不用发版（走同一套 clone → 改 → publish）；
--   2. `enabled = FALSE` 就是「临时下架某个样式」，不需要改代码；
--   3. `sort_order` 控制界面展示顺序。
--
-- ## value_kind 必须是 ENUM
--
-- 这个字段是条件码白名单的判别器（0012 引入）。标成 CONDITION_CODE 会让
-- 两个模板 ID 混进白名单 —— 后果不是报错，而是「一个拼错的条件码可能因为
-- 撞上某个枚举值而通过 N-08」（planner-config-whitelist.test.ts 的原话）。
--
-- ## 版本号是动态取的
--
-- 照 0015 的做法从各环境**当前发布版本**克隆，而不是硬编码 `clone(3, 4)`：
-- 运营可能已经在版本 3 之后发布过配置，硬编码会覆盖掉它。

DO $$
DECLARE
    source_version INTEGER;
    target_version INTEGER;
    target_id UUID;
    inserted INTEGER;
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
        '模板样式目录：登记 ink_paper_v1 与 blueprint_v1 及各自的示例图'
    );

    /*
     * field_key 用 `output.template_id` —— 与请求载荷里的路径
     * `output_preferences.template_id` 对应的那一段一致（配置中心的 field_key
     * 约定就是载荷路径，见 0012 的说明）。
     *
     * **元组形状刻意与 0012 一致**（`CROSS JOIN (VALUES ('field', 'option', …))`）：
     * `planner-config-coverage.test.ts` 的扫描器按 `('field_key', 'option_key'`
     * 这个形状抽行。换成 `VALUES (target_id, 'field', …)` 也能跑，
     * 但那些行会对扫描器**隐形** —— 于是靠扫 SQL 的门禁全部空转，
     * 而空转的门禁是绿的。
     *
     * sort_order 按 10 递增，也是 0012 的约定（留出插入空间）。
     */
    INSERT INTO planner_config_options
        (version_id, field_key, option_key, label, sort_order, enabled, metadata)
    SELECT target_id, seed.field_key, seed.option_key, seed.label, seed.sort_order, TRUE, seed.metadata
    FROM (VALUES
        (
            'output.template_id', 'ink_paper_v1', '水墨纸本', 10,
            '{"value_kind":"ENUM","preview_image":"/images/templates/ink-paper-v1.png"}'::jsonb
        ),
        (
            'output.template_id', 'blueprint_v1', '工程蓝图', 20,
            '{"value_kind":"ENUM","preview_image":"/images/templates/blueprint-v1.png"}'::jsonb
        )
    ) AS seed(field_key, option_key, label, sort_order, metadata)
    ON CONFLICT (version_id, field_key, option_key) DO UPDATE
        SET label = EXCLUDED.label,
            sort_order = EXCLUDED.sort_order,
            enabled = EXCLUDED.enabled,
            metadata = EXCLUDED.metadata;

    PERFORM publish_planner_config(target_version);

    /*
     * 后置断言。迁移「跑完没报错」与「数据真的对」是两件事 ——
     * 上面任何一条 WHERE 写错都会静默少改几行，而那时界面上表现为
     * 「某个样式选不到」或「选了提交被拒」，都不指向这条迁移。
     */
    SELECT COUNT(*) INTO inserted
    FROM planner_config_current
    WHERE field_key = 'output.template_id';

    IF inserted <> 2 THEN
        RAISE EXCEPTION '已发布配置里的模板行数是 %，期望 2', inserted;
    END IF;

    SELECT COUNT(*) INTO inserted
    FROM planner_config_current
    WHERE field_key = 'output.template_id'
      AND enabled = TRUE
      AND metadata ->> 'value_kind' = 'ENUM'
      AND metadata ->> 'preview_image' LIKE '/images/templates/%';

    IF inserted <> 2 THEN
        RAISE EXCEPTION '模板行里 enabled + value_kind=ENUM + 示例图齐备的只有 % 行，期望 2', inserted;
    END IF;

    /* 两个 option_key 必须正好是代码里的那两个，多一个少一个都不行 */
    SELECT COUNT(*) INTO inserted
    FROM planner_config_current
    WHERE field_key = 'output.template_id'
      AND option_key IN ('ink_paper_v1', 'blueprint_v1');

    IF inserted <> 2 THEN
        RAISE EXCEPTION '模板 option_key 与预期不符，匹配到 % 行', inserted;
    END IF;
END
$$;
