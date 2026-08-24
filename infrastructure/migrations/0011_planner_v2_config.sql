-- Planner V2.1：注册 P9 新增的 15 个条件码与新字段选项，发布配置版本 2
--
-- ## 为什么这条迁移是必交付项（P9 实施计划的「陷阱 1」）
--
-- apps/api 在有已发布 planner config 时，用**配置里的码集合替换**内置白名单：
--
--     const known = context.allowedConditionCodes?.has(code)
--                     ?? isKnownConditionCode(code);
--
-- 是 `??` 而不是并集。也就是说一旦数据库里有 PUBLISHED 版本，
-- `CONDITION_CODE_VALUES` 这份内置字典就**完全不参与判断**。
--
-- P9 往 conditions.ts 里追加了 15 个码（交通 5 / 住宿设施 6 / 消费重点 1 /
-- 饮食 3）。只加进代码而不注册进配置中心的后果是：装了配置中心的环境里，
-- 这些标签会被 N-08 以 REQ_CONDITION_CODE_UNKNOWN 拒掉整个请求 ——
-- 而界面上那个标签看起来完全正常，用户点它、勾它、提交，然后被拒。
--
-- ## 只有 `*.tags` 结尾的 field_key 参与白名单
--
-- 见上面那段代码的 `.filter(([fieldKey]) => fieldKey.endsWith('.tags'))`。
-- 因此新码必须落在以 `.tags` 结尾的 field_key 下，否则注册了也不生效。
-- 这是本迁移里最容易写错的一处：把交通码放进 `transport.mode_tags`（对）
-- 而不是 `transport.modes`（注册了但白名单里没有）。
--
-- ## 为什么用 clone + publish 而不是直接往版本 1 里插
--
-- 版本 1 是**已发布**的历史。往里插行会让「某个环境的版本 1 与另一个环境的
-- 版本 1 内容不同」，而配置版本存在的全部意义就是可回放与可回滚。
-- 回滚方式是 `SELECT publish_planner_config(1)`，不需要 down 迁移。

-- 版本 2 = 版本 1 的克隆 + 本次新增项
SELECT clone_planner_config(1, 2, 'Planner V2.1：补齐三态标签选项与 P9 新增条件码');

INSERT INTO planner_config_options (version_id, field_key, option_key, label, sort_order, metadata)
SELECT v.id, seed.field_key, seed.option_key, seed.label, seed.sort_order, seed.metadata
FROM planner_config_versions v
CROSS JOIN (VALUES
    -- ── 跨城交通（V2 字段表 PV2-05-001 的五项，rail 与 self_drive 已在版本 1）──
    ('transport.mode_tags', 'transport.flight', '飞机', 70, '{}'::jsonb),
    ('transport.mode_tags', 'transport.coach', '长途巴士', 80, '{}'::jsonb),
    ('transport.mode_tags', 'transport.ferry', '轮渡', 90, '{}'::jsonb),
    -- ── 当地交通（PV2-05-005 的六项，其余四项已在版本 1）──
    ('transport.mode_tags', 'transport.ride_hailing', '打车', 100, '{}'::jsonb),
    ('transport.mode_tags', 'transport.private_car', '包车', 110, '{}'::jsonb),
    -- ── 住宿设施（PV2-06-007 的十项，前四项已在版本 1）──
    ('transport.lodging_requirement_tags', 'accommodation.laundry', '有洗衣', 70, '{}'::jsonb),
    ('transport.lodging_requirement_tags', 'accommodation.bathtub', '有浴缸', 80, '{}'::jsonb),
    ('transport.lodging_requirement_tags', 'accommodation.gym', '有健身房', 90, '{}'::jsonb),
    ('transport.lodging_requirement_tags', 'accommodation.pool', '有泳池', 100, '{}'::jsonb),
    ('transport.lodging_requirement_tags', 'accommodation.workspace', '有办公空间', 110, '{}'::jsonb),
    ('transport.lodging_requirement_tags', 'accommodation.front_desk_24h', '24 小时前台', 120, '{}'::jsonb),
    -- ── 消费重点（PV2-03-006 的四项，前三项已在版本 1）──
    -- 「愿意为直飞多付钱」与 transport.flight_constraints（只接受直飞，HARD）
    -- 是两件事：前者是消费取向，后者是硬约束。
    ('budget.focus_tags', 'budget.direct_flight', '预算侧重直飞', 40, '{}'::jsonb),
    -- ── 饮食方式（PV2-07-002 的六项，前三项已在版本 1）──
    -- vegan 与 vegetarian 分开而不是用 value 表达程度：纯素排除蛋奶，
    -- 而「素食 + value:false」读作「不要素食」（条件码命名约定 1）。
    ('diet.tags', 'diet.vegan', '纯素', 50, '{}'::jsonb),
    ('diet.tags', 'diet.kosher', '犹太洁食', 60, '{}'::jsonb),
    ('diet.tags', 'diet.alcohol_free', '不饮酒', 70, '{}'::jsonb)
) AS seed(field_key, option_key, label, sort_order, metadata)
WHERE v.version = 2;

-- ── 九步问卷的新增枚举选项 ────────────────────────────────────
--
-- 这些 field_key **不以 `.tags` 结尾**，因此不参与条件码白名单 ——
-- 它们只供界面渲染选项与文案（`usePlannerOptions`）。
-- 契约里的枚举校验由 Zod 负责，配置中心在这里的作用是让运营能改文案与排序。
INSERT INTO planner_config_options (version_id, field_key, option_key, label, sort_order, metadata)
SELECT v.id, seed.field_key, seed.option_key, seed.label, seed.sort_order, '{}'::jsonb
FROM planner_config_versions v
CROSS JOIN (VALUES
    ('trip.destination_status', 'CONFIRMED', '已经确定', 10),
    ('trip.destination_status', 'SHORTLISTED', '有几个备选', 20),
    ('trip.destination_status', 'UNDECIDED', '完全没定', 30),
    ('trip.date_flexibility', 'FIXED', '日期固定', 10),
    ('trip.date_flexibility', 'PLUS_MINUS_1', '前后可差 1 天', 20),
    ('trip.date_flexibility', 'PLUS_MINUS_3', '前后可差 3 天', 30),
    ('trip.date_flexibility', 'WHOLE_WEEK', '整周都可以调', 40),
    ('trip.date_flexibility', 'MONTH_ONLY', '只定月份', 50),
    ('budget.mode', 'TOTAL', '整个旅行总预算', 10),
    ('budget.mode', 'PER_PERSON', '人均总预算', 20),
    ('budget.mode', 'TIER', '只知道旅行档次', 30),
    ('budget.mode', 'UNKNOWN', '暂时没概念', 40),
    -- V2 的四档与版本 1 的 budget.tiers 刻意不同名：那里有 STANDARD 与 CUSTOM
    -- 两个 V2 不存在的成员（前者是「舒适」的旧译名，后者表示「拖了滑块」）。
    ('budget.travel_tier', 'ECONOMY', '经济型', 10),
    ('budget.travel_tier', 'COMFORT', '舒适型', 20),
    ('budget.travel_tier', 'QUALITY', '品质型', 30),
    ('budget.travel_tier', 'LUXURY', '奢华型', 40),
    ('budget.currency', 'CNY', 'CNY ¥', 10),
    ('budget.currency', 'JPY', 'JPY JP¥', 20),
    ('budget.currency', 'USD', 'USD $', 30),
    ('budget.currency', 'EUR', 'EUR €', 40),
    ('budget.currency', 'GBP', 'GBP £', 50),
    ('budget.currency', 'HKD', 'HKD HK$', 60),
    ('travelers.mobility_level', 'NORMAL', '正常活动', 10),
    ('travelers.mobility_level', 'LESS_WALKING', '希望少走', 20),
    ('travelers.mobility_level', 'NO_LONG_STANDING', '不能久站', 30),
    ('travelers.mobility_level', 'AVOID_STAIRS', '避免大量台阶', 40),
    ('travelers.mobility_level', 'FREQUENT_REST', '需要频繁休息', 50),
    ('pace.walking_tolerance', 'UP_TO_3KM', '3 公里以内', 10),
    ('pace.walking_tolerance', 'KM_3_TO_5', '3 到 5 公里', 20),
    ('pace.walking_tolerance', 'KM_5_TO_8', '5 到 8 公里', 30),
    ('pace.walking_tolerance', 'KM_8_TO_12', '8 到 12 公里', 40),
    ('pace.walking_tolerance', 'OVER_12KM', '12 公里以上', 50),
    ('pace.hotel_change_tolerance', 'ZERO', '一次都不换', 10),
    ('pace.hotel_change_tolerance', 'ONE', '最多换 1 次', 20),
    ('pace.hotel_change_tolerance', 'TWO', '最多换 2 次', 30),
    ('pace.hotel_change_tolerance', 'THREE_PLUS', '3 次以上也行', 40),
    ('pace.hotel_change_tolerance', 'FOR_EXPERIENCE', '为了体验可以接受', 50),
    ('risk.exclusions', 'RED_EYE_FLIGHT', '红眼航班', 10),
    ('risk.exclusions', 'OVERNIGHT_GROUND', '夜间长途交通', 20),
    ('risk.exclusions', 'MULTI_TRANSFER', '多次转机', 30),
    ('risk.exclusions', 'REMOTE_AREA', '偏远地区', 40),
    ('risk.exclusions', 'LAST_MINUTE_CHANGE', '临时变更', 50),
    ('risk.exclusions', 'HIGH_RISK_ACTIVITY', '高风险活动', 60),
    ('risk.exclusions', 'LONG_QUEUE', '长时间排队', 70),
    ('food.dietary_requirements', 'VEGETARIAN', '素食', 10),
    ('food.dietary_requirements', 'VEGAN', '纯素', 20),
    ('food.dietary_requirements', 'HALAL', '清真', 30),
    ('food.dietary_requirements', 'KOSHER', '犹太洁食', 40),
    ('food.dietary_requirements', 'NO_SPICY', '不吃辣', 50),
    ('food.dietary_requirements', 'ALCOHOL_FREE', '不饮酒', 60),
    ('food.dietary_requirements', 'OTHER', '其他', 70),
    ('special.high_risk_activities', 'HIGH_ALTITUDE', '高原', 10),
    ('special.high_risk_activities', 'SCUBA_DIVING', '水肺潜水', 20),
    ('special.high_risk_activities', 'SKIING', '滑雪', 30),
    ('special.high_risk_activities', 'MOUNTAINEERING', '登山', 40),
    ('special.high_risk_activities', 'EXTREME_SPORTS', '跳伞 / 极限项目', 50)
) AS seed(field_key, option_key, label, sort_order)
WHERE v.version = 2;

-- 发布版本 2。它会把版本 1 置为 ARCHIVED（见 publish_planner_config）。
SELECT publish_planner_config(2);
