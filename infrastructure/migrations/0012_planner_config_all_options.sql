-- Planner V2.1：把九步问卷的全部 62 个选项列表纳入配置中心，发布版本 3
--
-- ## 这条迁移解决什么
--
-- P9-4b 用描述符表重写九步问卷时，把配置中心的**消费端**丢了：
-- `usePlannerOptions` 在整个 apps/web 里没有任何调用方，选项值从契约的
-- `*_VALUES` 硬编码进 descriptors.ts，文案从代码里的 `OPTION_LABEL` 查表。
-- 于是运营改配置**一处都不生效**，而删一个条件码更糟 ——
-- API 白名单跟着收缩（travel-plans.ts 的 `allowedConditionCodes`），
-- 而界面上那个标签还在，用户点它、提交，整个请求被 N-08 拒。
--
-- **更正 0011 第 68 行**：那里写着新增的 11 个 field_key「只供界面渲染选项与
-- 文案（`usePlannerOptions`）」—— 当时那个 hook 已经没有调用方了，那句话是错的。
-- 0011 本身不能改：迁移带 checksum，`migrate.ts` 会把内容变化报成 drift。
--
-- ## field_key 的新口径 = 选项所在的载荷路径
--
--   trip.date_flexibility                     单部件字段 = api_key
--   transport.flight_comfort.cabin            多部件 = api_key + 部件键
--   trip.locked_orders.type                   对象数组行内的键
--   food.allergy_details.allergens.severity   数组套数组，再深一层
--
-- 这个口径能从描述符表机械派生（apps/web 的 config-binding.ts），
-- 因此「配置里有哪些列表」与「界面上真实存在哪些列表」可以用断言绑住 ——
-- 见 config-binding.test.ts 与 planner-config-coverage.test.ts。
--
-- ## metadata.value_kind 取代「field_key 以 tags 结尾」
--
-- 旧判据是个命名约定，而新口径下装条件码的路径叫 `transport.intercity_modes`、
-- `lodging.amenities` —— 一个都不以 tags 结尾。更要紧的是它从来不够用：
-- 61 个条件码里有 18 个界面上**没有标签**（由 request.ts 从枚举答案投影出来，
-- 饮食要求 → diet.*、行动能力 → accessibility.*），它们必须在白名单里，
-- 却挂不到任何界面路径下。因此：
--
--   value_kind = 'CONDITION_CODE'   进 N-08 白名单，不论 field_key
--   value_kind = 'ENUM'             只供界面渲染
--
-- 投影专用的那 18 个落在 `conditions.projected` 下 —— 它与任何载荷路径都不相等，
-- 因此永远不会被渲染成标签。
--
-- ## 能力边界（写进 docs/规划器配置中心.md 的那张表）
--
-- 停用 / 改文案 / 改排序 / 重新启用：两类都是纯配置。
-- 新增：条件码可以（契约是域前缀正则），但新码还要进 conditions.ts 与
-- CONDITION_LABEL，否则通不过 Prompt 的分域遍历；枚举**不可能**，
-- 配置里加一个 Zod 枚举没有的成员只会得到一个点了提交被拒的按钮，
-- 因此前端解析器对枚举列表取「配置 ∩ 内置」。

SELECT clone_planner_config(2, 3, 'Planner V2.1：九步问卷全部选项纳入配置，field_key 改为载荷路径');

-- ── 停用 P8 的 16 个遗留 field_key ────────────────────────────
--
-- 它们是八步问卷时代的命名（`traveler.tags`、`budget.tiers`、`pace.intensity`…），
-- V2 里没有任何字段叫这些名字，代码里也已经逐个确认零消费方。
-- 按本表的规矩不物理删除 —— 历史版本要可回放，回滚是
-- `SELECT publish_planner_config(2)`。
--
-- 它们承载的条件码在下面按新口径重新注册，因此白名单不会因为这次停用而缺码
-- （由 planner-config-coverage.test.ts 双向断言守住）。
UPDATE planner_config_options o
SET enabled = FALSE
FROM planner_config_versions v
WHERE o.version_id = v.id
  AND v.version = 3
  AND o.field_key IN (
    'booking.existing',
    'traveler.senior_mobility',
    'traveler.tags',
    'budget.tiers',
    'budget.included_items',
    'budget.focus_tags',
    'pace.intensity',
    'pace.attractions_per_day',
    'pace.walking_limit_km',
    'pace.route_shape',
    'pace.need_tags',
    'transport.mode_tags',
    'transport.lodging_type_tags',
    'transport.lodging_requirement_tags',
    'diet.tags',
    'interest.tags'
  );

-- ── 62 个列表的选项 ──────────────────────────────────────────
--
-- 0011 已经按 V2 api_key 注册过 11 个 field_key，与下面有交集。冲突时
-- **只补 metadata 与 enabled，不动 label 与 sort_order**：那两列是运营的
-- 真相源，用内置文案覆盖会把运营改过的文案改回去。代价是这 11 个 field_key
-- 的文案沿用 0011（例如步行上限显示「3 公里以内」而不是内置的「≤ 3 km」）——
-- 而那正是「配置优先」应有的表现。

INSERT INTO planner_config_options (version_id, field_key, option_key, label, sort_order, metadata)
SELECT v.id, seed.field_key, seed.option_key, seed.label, seed.sort_order,
       '{"value_kind":"ENUM"}'::jsonb
FROM planner_config_versions v
CROSS JOIN (VALUES
    -- PV2-01-002 trip.destination_status
    ('trip.destination_status', 'CONFIRMED', '已经确定', 10),
    ('trip.destination_status', 'SHORTLISTED', '有几个备选', 20),
    ('trip.destination_status', 'UNDECIDED', '完全没定', 30),
    -- PV2-01-005 trip.date_flexibility
    ('trip.date_flexibility', 'FIXED', '日期固定', 10),
    ('trip.date_flexibility', 'PLUS_MINUS_1', '前后可差 1 天', 20),
    ('trip.date_flexibility', 'PLUS_MINUS_3', '前后可差 3 天', 30),
    ('trip.date_flexibility', 'WHOLE_WEEK', '整周都可以调', 40),
    ('trip.date_flexibility', 'MONTH_ONLY', '只定月份', 50),
    -- PV2-01-006 profile.trip_purposes
    ('profile.trip_purposes', 'LEISURE', '休闲度假', 10),
    ('profile.trip_purposes', 'HONEYMOON', '蜜月纪念', 20),
    ('profile.trip_purposes', 'FAMILY', '亲子陪伴', 30),
    ('profile.trip_purposes', 'FOOD', '美食', 40),
    ('profile.trip_purposes', 'PHOTOGRAPHY', '摄影', 50),
    ('profile.trip_purposes', 'SHOPPING', '购物', 60),
    ('profile.trip_purposes', 'SKI', '滑雪', 70),
    ('profile.trip_purposes', 'SHOW_SPORTS', '演出赛事', 80),
    ('profile.trip_purposes', 'BLEISURE', '商务 + 休闲', 90),
    ('profile.trip_purposes', 'VISIT_RELATIVES', '探亲', 100),
    ('profile.trip_purposes', 'OTHER', '其他', 110),
    -- PV2-01-007 profile.top_goals
    ('profile.top_goals', 'EAT_WELL', '吃得好', 10),
    ('profile.top_goals', 'STAY_WELL', '住得舒服', 20),
    ('profile.top_goals', 'LESS_HASSLE', '少折腾', 30),
    ('profile.top_goals', 'DEEP_EXPERIENCE', '深度体验', 40),
    ('profile.top_goals', 'PHOTOS', '拍照好看', 50),
    ('profile.top_goals', 'FAMILY_FUN', '亲子开心', 60),
    ('profile.top_goals', 'SHOPPING', '购物效率', 70),
    ('profile.top_goals', 'VALUE_FOR_MONEY', '控制预算', 80),
    ('profile.top_goals', 'FREE_TIME', '留白自由', 90),
    ('profile.top_goals', 'OTHER', '其他', 100),
    -- PV2-01-008 trip.locked_order_types
    ('trip.locked_order_types', 'INTERCITY_TRANSPORT', '往返交通', 10),
    ('trip.locked_order_types', 'LODGING', '酒店', 20),
    ('trip.locked_order_types', 'TICKETS', '门票 / 活动', 30),
    ('trip.locked_order_types', 'RESTAURANT', '餐厅', 40),
    ('trip.locked_order_types', 'TRANSFER', '接送', 50),
    -- PV2-01-009 trip.locked_orders.type
    ('trip.locked_orders.type', 'INTERCITY_TRANSPORT', '往返交通', 10),
    ('trip.locked_orders.type', 'LODGING', '酒店', 20),
    ('trip.locked_orders.type', 'TICKETS', '门票 / 活动', 30),
    ('trip.locked_orders.type', 'RESTAURANT', '餐厅', 40),
    ('trip.locked_orders.type', 'TRANSFER', '接送', 50),
    -- PV2-01-009 trip.locked_orders.changeability
    ('trip.locked_orders.changeability', 'CHANGEABLE', '可改可退', 10),
    ('trip.locked_orders.changeability', 'NON_REFUNDABLE', '不可改退', 20),
    ('trip.locked_orders.changeability', 'UNKNOWN', '不清楚', 30),
    -- PV2-02-002 travelers.profiles.relation
    ('travelers.profiles.relation', 'SELF', '本人', 10),
    ('travelers.profiles.relation', 'PARTNER', '伴侣', 20),
    ('travelers.profiles.relation', 'FRIEND', '朋友', 30),
    ('travelers.profiles.relation', 'CHILD', '孩子', 40),
    ('travelers.profiles.relation', 'PARENT', '父母', 50),
    ('travelers.profiles.relation', 'OTHER', '其他', 60),
    -- PV2-02-002 travelers.profiles.age_band
    ('travelers.profiles.age_band', 'INFANT', '婴幼儿', 10),
    ('travelers.profiles.age_band', 'CHILD', '孩子', 20),
    ('travelers.profiles.age_band', 'TEEN', '少年', 30),
    ('travelers.profiles.age_band', 'ADULT', '成人', 40),
    ('travelers.profiles.age_band', 'SENIOR', '长者', 50),
    -- PV2-02-003 travelers.minor_guardianship
    ('travelers.minor_guardianship', 'BOTH_PARENTS', '双亲陪同', 10),
    ('travelers.minor_guardianship', 'SINGLE_PARENT', '单亲陪同', 20),
    ('travelers.minor_guardianship', 'NON_PARENT_GUARDIAN', '非父母监护人', 30),
    ('travelers.minor_guardianship', 'UNACCOMPANIED', '独自出行', 40),
    -- PV2-02-004 travelers.mobility_level
    ('travelers.mobility_level', 'NORMAL', '正常活动', 10),
    ('travelers.mobility_level', 'LESS_WALKING', '希望少走', 20),
    ('travelers.mobility_level', 'NO_LONG_STANDING', '不能久站', 30),
    ('travelers.mobility_level', 'AVOID_STAIRS', '避免大量台阶', 40),
    ('travelers.mobility_level', 'FREQUENT_REST', '需要频繁休息', 50),
    -- PV2-02-005 travelers.child_needs
    ('travelers.child_needs', 'STROLLER_ACCESS', '婴儿车通行', 10),
    ('travelers.child_needs', 'CAR_SEAT', '儿童安全座椅', 20),
    ('travelers.child_needs', 'FIXED_NAP', '固定午睡', 30),
    ('travelers.child_needs', 'KIDS_MEAL', '儿童餐', 40),
    ('travelers.child_needs', 'FAMILY_ROOM', '亲子房', 50),
    ('travelers.child_needs', 'OTHER', '其他', 60),
    -- PV2-02-006 travelers.grouping_needs
    ('travelers.grouping_needs', 'SEPARATE_ROOMS', '分房', 10),
    ('travelers.grouping_needs', 'SEPARATE_CARS', '分车', 20),
    ('travelers.grouping_needs', 'SPLIT_ACTIVITIES', '可以分组活动', 30),
    ('travelers.grouping_needs', 'ALWAYS_TOGETHER', '大部分时间一起', 40),
    -- PV2-03-001 budget.mode
    ('budget.mode', 'TOTAL', '整个旅行总预算', 10),
    ('budget.mode', 'PER_PERSON', '人均总预算', 20),
    ('budget.mode', 'TIER', '只知道旅行档次', 30),
    ('budget.mode', 'UNKNOWN', '暂时没概念', 40),
    -- PV2-03-002 budget.currency
    ('budget.currency', 'CNY', 'CNY ¥', 10),
    ('budget.currency', 'JPY', 'JPY JP¥', 20),
    ('budget.currency', 'USD', 'USD $', 30),
    ('budget.currency', 'EUR', 'EUR €', 40),
    ('budget.currency', 'GBP', 'GBP £', 50),
    ('budget.currency', 'HKD', 'HKD HK$', 60),
    -- PV2-03-004 budget.travel_tier
    ('budget.travel_tier', 'ECONOMY', '经济型', 10),
    ('budget.travel_tier', 'COMFORT', '舒适型', 20),
    ('budget.travel_tier', 'QUALITY', '品质型', 30),
    ('budget.travel_tier', 'LUXURY', '奢华型', 40),
    -- PV2-03-006 budget.scope_and_priorities.included_items
    ('budget.scope_and_priorities.included_items', 'INTERCITY_TRANSPORT', '往返大交通', 10),
    ('budget.scope_and_priorities.included_items', 'ACCOMMODATION', '住宿', 20),
    ('budget.scope_and_priorities.included_items', 'MEALS', '餐饮', 30),
    ('budget.scope_and_priorities.included_items', 'LOCAL_TRANSPORT', '市内交通', 40),
    ('budget.scope_and_priorities.included_items', 'TICKETS', '活动门票', 50),
    ('budget.scope_and_priorities.included_items', 'SHOPPING', '购物开支', 60),
    -- PV2-04-003 pace.walking_tolerance
    ('pace.walking_tolerance', 'UP_TO_3KM', '≤ 3 km', 10),
    ('pace.walking_tolerance', 'KM_3_TO_5', '3–5 km', 20),
    ('pace.walking_tolerance', 'KM_5_TO_8', '5–8 km', 30),
    ('pace.walking_tolerance', 'KM_8_TO_12', '8–12 km', 40),
    ('pace.walking_tolerance', 'OVER_12KM', '12 km+', 50),
    -- PV2-04-004 pace.core_activities_per_day
    ('pace.core_activities_per_day', 'ONE', '1 个', 10),
    ('pace.core_activities_per_day', 'TWO_TO_THREE', '2–3 个', 20),
    ('pace.core_activities_per_day', 'FOUR_TO_FIVE', '4–5 个', 30),
    ('pace.core_activities_per_day', 'AS_MANY', '尽量多', 40),
    ('pace.core_activities_per_day', 'SYSTEM', '交给系统', 50),
    -- PV2-04-005 pace.free_time
    ('pace.free_time', 'NONE', '几乎不留', 10),
    ('pace.free_time', 'ABOUT_1H', '1 小时左右', 20),
    ('pace.free_time', 'H2_TO_3', '2–3 小时', 30),
    ('pace.free_time', 'HALF_DAY', '半天', 40),
    ('pace.free_time', 'DEPENDS', '视情况', 50),
    -- PV2-04-007 pace.hotel_change_tolerance
    ('pace.hotel_change_tolerance', 'ZERO', '一次都不换', 10),
    ('pace.hotel_change_tolerance', 'ONE', '最多换 1 次', 20),
    ('pace.hotel_change_tolerance', 'TWO', '最多换 2 次', 30),
    ('pace.hotel_change_tolerance', 'THREE_PLUS', '3 次以上也行', 40),
    ('pace.hotel_change_tolerance', 'FOR_EXPERIENCE', '为了体验可以接受', 50),
    -- PV2-04-008 risk.exclusions
    ('risk.exclusions', 'RED_EYE_FLIGHT', '红眼航班', 10),
    ('risk.exclusions', 'OVERNIGHT_GROUND', '夜间长途交通', 20),
    ('risk.exclusions', 'MULTI_TRANSFER', '多次转机', 30),
    ('risk.exclusions', 'REMOTE_AREA', '偏远地区', 40),
    ('risk.exclusions', 'LAST_MINUTE_CHANGE', '临时变更', 50),
    ('risk.exclusions', 'HIGH_RISK_ACTIVITY', '高风险活动', 60),
    ('risk.exclusions', 'LONG_QUEUE', '长时间排队', 70),
    -- PV2-05-002 transport.flight_constraints.transfer_tolerance
    ('transport.flight_constraints.transfer_tolerance', 'DIRECT_ONLY', '只接受直飞', 10),
    ('transport.flight_constraints.transfer_tolerance', 'DIRECT_PREFERRED', '优先直飞', 20),
    ('transport.flight_constraints.transfer_tolerance', 'MAX_ONE_TRANSFER', '最多 1 次转机', 30),
    ('transport.flight_constraints.transfer_tolerance', 'MULTI_TRANSFER_OK', '可多次转机', 40),
    -- PV2-05-003 transport.flight_comfort.cabin
    ('transport.flight_comfort.cabin', 'ECONOMY', '经济舱', 10),
    ('transport.flight_comfort.cabin', 'PREMIUM_ECONOMY', '超级经济舱', 20),
    ('transport.flight_comfort.cabin', 'BUSINESS', '商务舱', 30),
    ('transport.flight_comfort.cabin', 'FIRST', '头等舱', 40),
    -- PV2-05-003 transport.flight_comfort.seats
    ('transport.flight_comfort.seats', 'WINDOW', '靠窗', 10),
    ('transport.flight_comfort.seats', 'AISLE', '过道', 20),
    ('transport.flight_comfort.seats', 'TOGETHER', '连座', 30),
    -- PV2-05-004 transport.time_preferences.windows
    ('transport.time_preferences.windows', 'EARLY_MORNING', '清晨', 10),
    ('transport.time_preferences.windows', 'MORNING', '上午', 20),
    ('transport.time_preferences.windows', 'AFTERNOON', '下午', 30),
    ('transport.time_preferences.windows', 'EVENING', '晚间', 40),
    -- PV2-05-006 transport.self_drive.experience
    ('transport.self_drive.experience', 'UNDER_1Y', '不足 1 年', 10),
    ('transport.self_drive.experience', 'Y1_TO_3', '1–3 年', 20),
    ('transport.self_drive.experience', 'OVER_3Y', '3 年以上', 30),
    -- PV2-05-006 transport.self_drive.license_status
    ('transport.self_drive.license_status', 'VALID_LICENSE', '持有效驾照', 10),
    ('transport.self_drive.license_status', 'HAS_IDP', '有 IDP / 翻译件', 20),
    ('transport.self_drive.license_status', 'NEEDS_CHECK', '需要核验', 30),
    -- PV2-05-006 transport.self_drive.car_type
    ('transport.self_drive.car_type', 'SEDAN', '普通轿车', 10),
    ('transport.self_drive.car_type', 'SUV', 'SUV', 20),
    ('transport.self_drive.car_type', 'VAN_7', '7 座', 30),
    ('transport.self_drive.car_type', 'WITH_CHILD_SEAT', '带儿童座椅', 40),
    -- PV2-05-007 transport.luggage_profile.large_items
    ('transport.luggage_profile.large_items', 'NONE', '没有', 10),
    ('transport.luggage_profile.large_items', 'STROLLER', '婴儿车', 20),
    ('transport.luggage_profile.large_items', 'CAMERA_GEAR', '摄影器材', 30),
    ('transport.luggage_profile.large_items', 'SPORTS_GEAR', '运动装备', 40),
    ('transport.luggage_profile.large_items', 'OTHER', '其他', 50),
    -- PV2-06-003 lodging.room_configuration.bed_type
    ('lodging.room_configuration.bed_type', 'DOUBLE', '1 张大床', 10),
    ('lodging.room_configuration.bed_type', 'TWIN', '2 张单人床', 20),
    ('lodging.room_configuration.bed_type', 'EXTRA_BED', '大床 + 加床', 30),
    ('lodging.room_configuration.bed_type', 'CONNECTING', '连通房', 40),
    ('lodging.room_configuration.bed_type', 'FAMILY', '家庭房', 50),
    ('lodging.room_configuration.bed_type', 'SEPARATE', '分开的房间', 60),
    -- PV2-06-005 lodging.location_priorities
    ('lodging.location_priorities', 'TRANSIT_CONVENIENT', '交通便利', 10),
    ('lodging.location_priorities', 'WALK_TO_SIGHTS', '景点步行可达', 20),
    ('lodging.location_priorities', 'QUIET', '安静好睡', 30),
    ('lodging.location_priorities', 'NIGHTLIFE', '夜生活方便', 40),
    ('lodging.location_priorities', 'SHOPPING', '购物方便', 50),
    ('lodging.location_priorities', 'SEA_OR_NATURE', '海景 / 自然', 60),
    ('lodging.location_priorities', 'HOTEL_ITSELF', '酒店本身', 70),
    -- PV2-06-006 lodging.class_and_brand.hotel_class
    ('lodging.class_and_brand.hotel_class', 'ANY', '无要求', 10),
    ('lodging.class_and_brand.hotel_class', 'THREE_PLUS', '3 星以上', 20),
    ('lodging.class_and_brand.hotel_class', 'FOUR_PLUS', '4 星以上', 30),
    ('lodging.class_and_brand.hotel_class', 'FIVE', '5 星', 40),
    -- PV2-06-008 lodging.sleep_checkin_needs.needs
    ('lodging.sleep_checkin_needs.needs', 'VERY_QUIET', '非常安静', 10),
    ('lodging.sleep_checkin_needs.needs', 'HIGH_FLOOR', '高楼层', 20),
    ('lodging.sleep_checkin_needs.needs', 'NON_SMOKING', '非吸烟房', 30),
    ('lodging.sleep_checkin_needs.needs', 'LATE_CHECK_IN', '晚到入住', 40),
    ('lodging.sleep_checkin_needs.needs', 'EARLY_CHECK_IN', '提前入住', 50),
    ('lodging.sleep_checkin_needs.needs', 'LATE_CHECK_OUT', '晚退房', 60),
    -- PV2-07-001 food.experience_tags
    ('food.experience_tags', 'LOCAL_SPECIALTY', '当地特色', 10),
    ('food.experience_tags', 'FINE_DINING', 'Fine Dining', 20),
    ('food.experience_tags', 'STREET_FOOD', '街头美食', 30),
    ('food.experience_tags', 'MARKET', '市场', 40),
    ('food.experience_tags', 'CAFE_DESSERT', '咖啡甜品', 50),
    ('food.experience_tags', 'BAR_IZAKAYA', '酒吧 / 居酒屋', 60),
    ('food.experience_tags', 'CHINESE', '中餐', 70),
    ('food.experience_tags', 'JAPANESE', '日料', 80),
    ('food.experience_tags', 'WESTERN', '西餐', 90),
    -- PV2-07-002 food.dietary_requirements
    ('food.dietary_requirements', 'VEGETARIAN', '素食', 10),
    ('food.dietary_requirements', 'VEGAN', '纯素', 20),
    ('food.dietary_requirements', 'HALAL', '清真', 30),
    ('food.dietary_requirements', 'KOSHER', '犹太洁食', 40),
    ('food.dietary_requirements', 'NO_SPICY', '不吃辣', 50),
    ('food.dietary_requirements', 'ALCOHOL_FREE', '不饮酒', 60),
    ('food.dietary_requirements', 'OTHER', '其他', 70),
    -- PV2-07-003 food.has_allergies
    ('food.has_allergies', 'NO', '没有', 10),
    ('food.has_allergies', 'YES', '有', 20),
    ('food.has_allergies', 'UNSURE', '不确定', 30),
    -- PV2-07-004 food.allergy_details.allergens.severity
    ('food.allergy_details.allergens.severity', 'MILD', '轻微', 10),
    ('food.allergy_details.allergens.severity', 'MODERATE', '中等', 20),
    ('food.allergy_details.allergens.severity', 'SEVERE', '严重', 30),
    ('food.allergy_details.allergens.severity', 'ANAPHYLAXIS', '过敏性休克风险', 40),
    -- PV2-07-005 food.dining_style.budget_level
    ('food.dining_style.budget_level', 'MOSTLY_CASUAL', '普通为主', 10),
    ('food.dining_style.budget_level', 'MODERATE', '适中，特色餐愿意多花', 20),
    ('food.dining_style.budget_level', 'QUALITY_FIRST', '品质餐厅优先', 30),
    -- PV2-07-005 food.dining_style.queue_attitude
    ('food.dining_style.queue_attitude', 'WILL_BOOK_AHEAD', '愿意提前预约', 10),
    ('food.dining_style.queue_attitude', 'WILL_QUEUE', '愿意排队', 20),
    ('food.dining_style.queue_attitude', 'AVOID_QUEUE', '尽量不排长队', 30),
    -- PV2-08-001 special.has_health_or_accessibility_needs
    ('special.has_health_or_accessibility_needs', 'NO', '没有', 10),
    ('special.has_health_or_accessibility_needs', 'YES', '有', 20),
    ('special.has_health_or_accessibility_needs', 'UNSURE', '不确定', 30),
    -- PV2-08-002 special.health_accessibility_needs
    ('special.health_accessibility_needs', 'WHEELCHAIR_OR_WALKER', '轮椅 / 助行', 10),
    ('special.health_accessibility_needs', 'HEARING_VISION_AID', '视听辅助', 20),
    ('special.health_accessibility_needs', 'PREGNANCY', '孕期', 30),
    ('special.health_accessibility_needs', 'CHRONIC_CONDITION', '慢性病影响', 40),
    ('special.health_accessibility_needs', 'NO_LONG_STANDING', '不能久站', 50),
    ('special.health_accessibility_needs', 'MEDICAL_DEVICE', '医疗设备', 60),
    ('special.health_accessibility_needs', 'OTHER', '其他', 70),
    -- PV2-08-003 special.high_risk_activities
    ('special.high_risk_activities', 'HIGH_ALTITUDE', '高原', 10),
    ('special.high_risk_activities', 'SCUBA_DIVING', '水肺潜水', 20),
    ('special.high_risk_activities', 'SKIING', '滑雪', 30),
    ('special.high_risk_activities', 'MOUNTAINEERING', '登山', 40),
    ('special.high_risk_activities', 'EXTREME_SPORTS', '跳伞 / 极限项目', 50),
    -- PV2-08-004 special.medication_status
    ('special.medication_status', 'NO', '不需要', 10),
    ('special.medication_status', 'YES', '需要', 20),
    ('special.medication_status', 'UNSURE', '不确定', 30),
    -- PV2-08-006 documents.passport_status.status
    ('documents.passport_status.status', 'VALID', '在有效期内', 10),
    ('documents.passport_status.status', 'APPLYING', '待办理', 20),
    ('documents.passport_status.status', 'RENEWING', '更新中', 30),
    -- PV2-08-007 documents.visa_status.status
    ('documents.visa_status.status', 'HELD', '已有', 10),
    ('documents.visa_status.status', 'NOT_APPLIED', '未办理', 20),
    ('documents.visa_status.status', 'IN_PROGRESS', '办理中', 30),
    ('documents.visa_status.status', 'UNSURE', '不确定', 40),
    ('documents.visa_status.status', 'MAYBE_EXEMPT', '可能免签', 50),
    -- PV2-08-008 insurance.status
    ('insurance.status', 'HELD', '已有', 10),
    ('insurance.status', 'NONE', '没有', 20),
    ('insurance.status', 'WILL_BUY', '待购买', 30),
    ('insurance.status', 'UNSURE', '不确定', 40),
    -- PV2-08-009 safety.contexts
    ('safety.contexts', 'SOLO_TRAVEL', '独自旅行', 10),
    ('safety.contexts', 'SOLO_FEMALE', '女性独行', 20),
    ('safety.contexts', 'HEAVY_NIGHTLIFE', '夜生活较多', 30),
    ('safety.contexts', 'LATE_NIGHT_ARRIVAL', '深夜抵达', 40),
    ('safety.contexts', 'REMOTE_AREA', '偏远地区', 50),
    -- PV2-09-003 service.notification_preferences.mode
    ('service.notification_preferences.mode', 'REALTIME', '实时提醒', 10),
    ('service.notification_preferences.mode', 'DAILY_MORNING', '每日晨报', 20),
    ('service.notification_preferences.mode', 'DAILY_EVENING', '每日晚报', 30),
    ('service.notification_preferences.mode', 'IMPORTANT_ONLY', '仅重要变化', 40),
    -- PV2-09-003 service.notification_preferences.channels
    ('service.notification_preferences.channels', 'IN_APP', '站内通知', 10),
    ('service.notification_preferences.channels', 'EMAIL', '邮件', 20),
    -- PV2-10-001 pretrip.connectivity.esim
    ('pretrip.connectivity.esim', 'SUPPORTED', '支持 eSIM', 10),
    ('pretrip.connectivity.esim', 'NOT_SUPPORTED', '不支持 eSIM', 20),
    ('pretrip.connectivity.esim', 'UNSURE', '不确定', 30),
    -- PV2-10-001 pretrip.connectivity.preferences
    ('pretrip.connectivity.preferences', 'ESIM', 'eSIM', 10),
    ('pretrip.connectivity.preferences', 'ROAMING', '漫游', 20),
    ('pretrip.connectivity.preferences', 'PHYSICAL_SIM', '实体 SIM', 30),
    ('pretrip.connectivity.preferences', 'WIFI', '随身 Wi-Fi', 40),
    -- PV2-10-002 pretrip.payment_methods
    ('pretrip.payment_methods', 'VISA', 'Visa', 10),
    ('pretrip.payment_methods', 'MASTERCARD', 'Mastercard', 20),
    ('pretrip.payment_methods', 'AMEX', 'Amex', 30),
    ('pretrip.payment_methods', 'APPLE_PAY', 'Apple Pay', 40),
    ('pretrip.payment_methods', 'GOOGLE_PAY', 'Google Pay', 50),
    ('pretrip.payment_methods', 'CASH', '现金', 60),
    ('pretrip.payment_methods', 'OTHER', '其他', 70),
    -- PV2-10-003 pretrip.loyalty_programs.kind
    ('pretrip.loyalty_programs.kind', 'AIRLINE', '航空', 10),
    ('pretrip.loyalty_programs.kind', 'HOTEL', '酒店', 20),
    ('pretrip.loyalty_programs.kind', 'CAR_RENTAL', '租车', 30),
    ('pretrip.loyalty_programs.kind', 'CREDIT_CARD', '信用卡', 40),
    -- PV2-10-004 pretrip.emergency_contact.location_sharing
    ('pretrip.emergency_contact.location_sharing', 'NEVER', '不共享', 10),
    ('pretrip.emergency_contact.location_sharing', 'EMERGENCY_ONLY', '仅紧急时', 20),
    ('pretrip.emergency_contact.location_sharing', 'DURING_TRIP', '旅行期间共享', 30),
    -- PV2-10-006 service.monitoring_topics
    ('service.monitoring_topics', 'WEATHER', '天气', 10),
    ('service.monitoring_topics', 'FLIGHT_OR_TRAIN', '航班车次', 20),
    ('service.monitoring_topics', 'ATTRACTION_CLOSURE', '景点关闭', 30),
    ('service.monitoring_topics', 'TRANSIT_DISRUPTION', '公交中断', 40),
    ('service.monitoring_topics', 'SAFETY_ALERT', '安全警报', 50),
    ('service.monitoring_topics', 'BOOKING_CONFIRMATION', '预订确认', 60)
) AS seed(field_key, option_key, label, sort_order)
WHERE v.version = 3
ON CONFLICT (version_id, field_key, option_key)
DO UPDATE SET metadata = planner_config_options.metadata || EXCLUDED.metadata, enabled = TRUE;

INSERT INTO planner_config_options (version_id, field_key, option_key, label, sort_order, metadata)
SELECT v.id, seed.field_key, seed.option_key, seed.label, seed.sort_order,
       '{"value_kind":"CONDITION_CODE"}'::jsonb
FROM planner_config_versions v
CROSS JOIN (VALUES
    -- PV2-03-006 budget.scope_and_priorities.priorities
    ('budget.scope_and_priorities.priorities', 'budget.lodging_quality', '预算侧重住宿品质', 10),
    ('budget.scope_and_priorities.priorities', 'budget.unique_experience', '预算侧重特色体验', 20),
    ('budget.scope_and_priorities.priorities', 'budget.transport_convenience', '预算侧重交通便利', 30),
    ('budget.scope_and_priorities.priorities', 'budget.direct_flight', '愿为直飞多花', 40),
    -- PV2-05-001 transport.intercity_modes
    ('transport.intercity_modes', 'transport.flight', '飞机出行', 10),
    ('transport.intercity_modes', 'transport.rail', '铁路出行', 20),
    ('transport.intercity_modes', 'transport.coach', '长途巴士', 30),
    ('transport.intercity_modes', 'transport.ferry', '轮渡', 40),
    ('transport.intercity_modes', 'transport.self_drive', '自驾', 50),
    -- PV2-05-005 transport.local_modes
    ('transport.local_modes', 'transport.public_transit', '优先公共交通', 10),
    ('transport.local_modes', 'transport.walking_first', '优先步行', 20),
    ('transport.local_modes', 'transport.ride_hailing', '打车或网约车', 30),
    ('transport.local_modes', 'transport.private_car', '包车', 40),
    ('transport.local_modes', 'transport.cycling', '单车出行', 50),
    ('transport.local_modes', 'transport.self_drive', '自驾', 60),
    -- PV2-06-001 lodging.types
    ('lodging.types', 'accommodation.hotel', '住酒店', 10),
    ('lodging.types', 'accommodation.homestay', '住民宿', 20),
    ('lodging.types', 'accommodation.apartment', '住公寓', 30),
    ('lodging.types', 'accommodation.resort', '住度假村', 40),
    ('lodging.types', 'accommodation.hostel', '住青年旅舍', 50),
    -- PV2-06-007 lodging.amenities
    ('lodging.amenities', 'accommodation.elevator', '住宿有电梯', 10),
    ('lodging.amenities', 'accommodation.private_bath', '独立卫浴', 20),
    ('lodging.amenities', 'accommodation.breakfast', '含早餐', 30),
    ('lodging.amenities', 'accommodation.kitchen', '带厨房', 40),
    ('lodging.amenities', 'accommodation.laundry', '可洗衣', 50),
    ('lodging.amenities', 'accommodation.bathtub', '有浴缸', 60),
    ('lodging.amenities', 'accommodation.gym', '有健身房', 70),
    ('lodging.amenities', 'accommodation.pool', '有泳池', 80),
    ('lodging.amenities', 'accommodation.workspace', '有工作区', 90),
    ('lodging.amenities', 'accommodation.front_desk_24h', '24 小时前台', 100),
    -- PV2-07-006 interests.tags
    ('interests.tags', 'interest.history_culture', '历史与人文', 10),
    ('interests.tags', 'interest.nature', '自然风光', 20),
    ('interests.tags', 'interest.food', '本地美食', 30),
    ('interests.tags', 'interest.shopping', '购物', 40),
    ('interests.tags', 'interest.art_museum', '艺术与博物馆', 50),
    ('interests.tags', 'interest.nightlife', '夜间活动', 60),
    ('interests.tags', 'interest.photography', '摄影机位', 70),
    ('interests.tags', 'interest.family_kids', '亲子友好', 80),
    ('interests.tags', 'interest.city_walk', '城市漫步', 90),
    ('interests.tags', 'interest.cafe', '咖啡馆探店', 100),
    ('interests.tags', 'interest.hot_spring', '温泉体验', 110),
    ('interests.tags', 'interest.theme_park', '主题乐园', 120),
    ('interests.tags', 'interest.zoo_aquarium', '动物园与水族馆', 130),
    ('interests.tags', 'interest.light_hiking', '轻量徒步', 140),
    -- 界面上没有标签的投影产物
    ('conditions.projected', 'transport.avoid_transfer', '尽量少换乘', 10),
    ('conditions.projected', 'accommodation.near_transit', '住宿靠近地铁或车站', 20),
    ('conditions.projected', 'accommodation.family_room', '家庭房', 30),
    ('conditions.projected', 'accommodation.shared_dorm', '合住多人间', 40),
    ('conditions.projected', 'accommodation.single_base', '全程固定一处住宿', 50),
    ('conditions.projected', 'accessibility.wheelchair', '需轮椅通行', 60),
    ('conditions.projected', 'accessibility.stroller', '需推车通行', 70),
    ('conditions.projected', 'accessibility.low_walking', '步行量要少', 80),
    ('conditions.projected', 'accessibility.child_car_seat', '需儿童安全座椅', 90),
    ('conditions.projected', 'diet.vegetarian', '素食', 100),
    ('conditions.projected', 'diet.halal', '清真', 110),
    ('conditions.projected', 'diet.no_spicy', '不吃辣', 120),
    ('conditions.projected', 'diet.allergy_seafood', '海鲜过敏', 130),
    ('conditions.projected', 'diet.vegan', '纯素', 140),
    ('conditions.projected', 'diet.kosher', '犹太洁食', 150),
    ('conditions.projected', 'diet.alcohol_free', '不饮酒', 160),
    ('conditions.projected', 'schedule.no_late_night', '不安排太晚的行程', 170),
    ('conditions.projected', 'schedule.daily_rest', '每日固定午休', 180)
) AS seed(field_key, option_key, label, sort_order)
WHERE v.version = 3
ON CONFLICT (version_id, field_key, option_key)
DO UPDATE SET metadata = planner_config_options.metadata || EXCLUDED.metadata, enabled = TRUE;

-- 发布版本 3。版本 2 自动归档（见 publish_planner_config）。
SELECT publish_planner_config(3);
