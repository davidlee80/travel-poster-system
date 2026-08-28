-- 0016_template_suite_rename.sql
--
-- 把 template_id 从「页布局 ID」正名为「样式套件 ID」（R-85）。
--
-- ## 为什么需要这次迁移
--
-- 旧枚举是 ['travel_infographic_v1', 'travel_full_plan_v1'] —— 这两个值是**页型**
-- 而不是样式：前者是每日页、后者是全览页。页型被编码进了模板 ID，于是同一份计划的
-- 展示数据带着两个不同的 template_id。
--
-- 产品语义是「一个样式模板 = 一整套视觉方案，同时提供全览页与每日页」，而
-- plan_presentations_uk 早就是按这个语义建的：
--
--   UNIQUE (plan_version_id, template_id, page_type, COALESCE(day_number, -1))
--
-- template_id 与 page_type 是两个独立的列。因此不需要改表结构，
-- 只需要把两个旧值合并为一个套件 ID。
--
-- ## 为什么不会撞唯一键
--
-- plan_presentations_uk：合并后日页是 (v, ink_paper_v1, DAILY_POSTER, N)、
-- 全览页是 (v, ink_paper_v1, FULL_PLAN, -1)，page_type 不同因此不撞。
--
-- plan_asset_bindings_uk (plan_version_id, template_id, slot_id)：全览页的
-- asset_requirements 是空数组（presentation-plan.ts），因此全览页从不产生绑定 ——
-- 该表里只有 travel_infographic_v1 一个值，合并是一对一改名。
-- 下面的断言会在这个前提不成立时中止事务。
--
-- ## view_model 里那一份也要改
--
-- template_id 同时存在于 plan_presentations 的**列**与 view_model 的 JSONB 里。
-- 只改列会让两处不一致，而渲染路由是按 ViewModel 里那个值选组件的（R-85）——
-- 表现是「列上是新套件、渲染用旧组件」，两处单独看都对。

BEGIN;

UPDATE plan_presentations
   SET template_id = 'ink_paper_v1'
 WHERE template_id IN ('travel_infographic_v1', 'travel_full_plan_v1');

UPDATE plan_asset_bindings
   SET template_id = 'ink_paper_v1'
 WHERE template_id IN ('travel_infographic_v1', 'travel_full_plan_v1');

UPDATE exports
   SET template_id = 'ink_paper_v1'
 WHERE template_id IN ('travel_infographic_v1', 'travel_full_plan_v1');

UPDATE plan_presentations
   SET view_model = jsonb_set(view_model, '{template_id}', '"ink_paper_v1"')
 WHERE view_model ->> 'template_id' IN ('travel_infographic_v1', 'travel_full_plan_v1');

-- 后置断言。任一条不成立就抛异常中止整个事务 —— 迁移要么全成要么不动，
-- 因为「一半迁移了」的状态下渲染会按套件读不到展示数据。
DO LANGUAGE plpgsql $migration$
DECLARE
  leftover integer;
BEGIN
  SELECT count(*) INTO leftover
    FROM plan_presentations
   WHERE template_id IN ('travel_infographic_v1', 'travel_full_plan_v1')
      OR view_model ->> 'template_id' IN ('travel_infographic_v1', 'travel_full_plan_v1');
  IF leftover > 0 THEN
    RAISE EXCEPTION 'plan_presentations 残留 % 行旧 template_id（列或 view_model）', leftover;
  END IF;

  SELECT count(*) INTO leftover
    FROM plan_asset_bindings
   WHERE template_id IN ('travel_infographic_v1', 'travel_full_plan_v1');
  IF leftover > 0 THEN
    RAISE EXCEPTION 'plan_asset_bindings 残留 % 行旧 template_id', leftover;
  END IF;

  SELECT count(*) INTO leftover
    FROM exports
   WHERE template_id IN ('travel_infographic_v1', 'travel_full_plan_v1');
  IF leftover > 0 THEN
    RAISE EXCEPTION 'exports 残留 % 行旧 template_id', leftover;
  END IF;

  -- 列与 JSONB 必须一致：不一致时渲染按 ViewModel 选组件会与列上的记录错开
  SELECT count(*) INTO leftover
    FROM plan_presentations
   WHERE template_id <> view_model ->> 'template_id';
  IF leftover > 0 THEN
    RAISE EXCEPTION 'plan_presentations 有 % 行的列与 view_model.template_id 不一致', leftover;
  END IF;
END
$migration$;

COMMIT;
