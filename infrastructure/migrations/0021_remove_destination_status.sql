-- 删除「目的地是否已经确定」字段(PV2-01-002)
--
-- 原因:该字段是冗余的,用户直接选择目的地即可,不需要先回答「是否已经确定」
--
-- 影响:
-- - 删除 trip.destination_status 的所有选项配置
-- - 契约中 PlannerTripSchema 的 destination_status 字段已删除
-- - 前端 descriptors.ts 中的 PV2-01-002 描述符已删除

DELETE FROM planner_config_options
WHERE field_key = 'trip.destination_status';

-- 删除该字段的所有选项(包括历史版本)
DELETE FROM planner_config_options
WHERE field_key = 'trip.destination_status'
  AND option_key IN ('CONFIRMED', 'SHORTLISTED', 'UNDECIDED');
