-- 手机号账号与规划器配置中心

ALTER TABLE users ADD COLUMN phone_e164 VARCHAR(20);
ALTER TABLE users ADD COLUMN phone_verified_at TIMESTAMPTZ;

CREATE UNIQUE INDEX users_phone_e164_uk
    ON users (phone_e164) WHERE phone_e164 IS NOT NULL;

ALTER TABLE users DROP CONSTRAINT users_registered_shape;
ALTER TABLE users ADD CONSTRAINT users_registered_shape CHECK (
    user_type <> 'REGISTERED'
    OR (email IS NOT NULL OR (phone_e164 IS NOT NULL AND phone_verified_at IS NOT NULL))
);

ALTER TABLE users DROP CONSTRAINT users_anonymous_shape;
ALTER TABLE users ADD CONSTRAINT users_anonymous_shape CHECK (
    user_type <> 'ANONYMOUS'
    OR (email IS NULL AND phone_e164 IS NULL AND phone_verified_at IS NULL
        AND password_hash IS NULL AND anon_token_hash IS NOT NULL AND anon_expires_at IS NOT NULL)
);

CREATE TABLE planner_config_versions (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    version INTEGER NOT NULL UNIQUE,
    status VARCHAR(20) NOT NULL CHECK (status IN ('DRAFT', 'PUBLISHED', 'ARCHIVED')),
    note TEXT,
    published_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CONSTRAINT planner_config_published_shape CHECK (
        (status = 'PUBLISHED' AND published_at IS NOT NULL)
        OR (status <> 'PUBLISHED' AND published_at IS NULL)
    )
);

CREATE UNIQUE INDEX planner_config_one_published_uk
    ON planner_config_versions ((status)) WHERE status = 'PUBLISHED';

CREATE TABLE planner_config_options (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    version_id UUID NOT NULL REFERENCES planner_config_versions(id) ON DELETE CASCADE,
    field_key VARCHAR(80) NOT NULL,
    option_key VARCHAR(120) NOT NULL,
    label VARCHAR(120) NOT NULL,
    sort_order INTEGER NOT NULL DEFAULT 0,
    enabled BOOLEAN NOT NULL DEFAULT TRUE,
    metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE (version_id, field_key, option_key)
);

CREATE INDEX planner_config_options_lookup_idx
    ON planner_config_options (version_id, field_key, enabled, sort_order);

CREATE TRIGGER planner_config_versions_set_updated_at
    BEFORE UPDATE ON planner_config_versions
    FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TRIGGER planner_config_options_set_updated_at
    BEFORE UPDATE ON planner_config_options
    FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE OR REPLACE FUNCTION clone_planner_config(source_version INTEGER, new_version INTEGER, new_note TEXT DEFAULT NULL)
RETURNS UUID AS $$
DECLARE
    source_id UUID;
    target_id UUID;
BEGIN
    SELECT id INTO source_id FROM planner_config_versions WHERE version = source_version;
    IF source_id IS NULL THEN RAISE EXCEPTION 'planner config version % not found', source_version; END IF;
    INSERT INTO planner_config_versions (version, status, note)
    VALUES (new_version, 'DRAFT', new_note) RETURNING id INTO target_id;
    INSERT INTO planner_config_options (version_id, field_key, option_key, label, sort_order, enabled, metadata)
    SELECT target_id, field_key, option_key, label, sort_order, enabled, metadata
    FROM planner_config_options WHERE version_id = source_id;
    RETURN target_id;
END;
$$ LANGUAGE plpgsql;

CREATE OR REPLACE FUNCTION publish_planner_config(target_version INTEGER)
RETURNS VOID AS $$
DECLARE
    target_id UUID;
BEGIN
    SELECT id INTO target_id
    FROM planner_config_versions
    WHERE version = target_version AND status = 'DRAFT'
    FOR UPDATE;
    IF target_id IS NULL THEN RAISE EXCEPTION 'draft planner config version % not found', target_version; END IF;
    UPDATE planner_config_versions
    SET status = 'ARCHIVED', published_at = NULL
    WHERE status = 'PUBLISHED';
    UPDATE planner_config_versions
    SET status = 'PUBLISHED', published_at = NOW()
    WHERE id = target_id;
END;
$$ LANGUAGE plpgsql;

CREATE VIEW planner_config_current AS
SELECT v.version, v.published_at, o.field_key, o.option_key, o.label,
       o.sort_order, o.enabled, o.metadata
FROM planner_config_versions v
JOIN planner_config_options o ON o.version_id = v.id
WHERE v.status = 'PUBLISHED';

WITH v AS (
    INSERT INTO planner_config_versions (version, status, note, published_at)
    VALUES (1, 'PUBLISHED', '内置规划器选项初始版本', NOW())
    RETURNING id
)
INSERT INTO planner_config_options (version_id, field_key, option_key, label, sort_order, metadata)
SELECT v.id, seed.field_key, seed.option_key, seed.label, seed.sort_order, seed.metadata
FROM v
CROSS JOIN (VALUES
    ('traveler.tags', 'accommodation.family_room', '家庭房', 10, '{}'::jsonb),
    ('traveler.tags', 'accommodation.single_base', '全程固定一处住宿', 20, '{}'::jsonb),
    ('traveler.senior_mobility', 'NORMAL', '行动自如', 10, '{}'::jsonb),
    ('traveler.senior_mobility', 'LIMITED', '行动较慢', 20, '{}'::jsonb),
    ('traveler.senior_mobility', 'WHEELCHAIR', '需要轮椅', 30, '{}'::jsonb),
    ('budget.tiers', 'ECONOMY', '经济穷游', 10, '{"icon":"🎒","description":"青旅、经济酒店、公共交通","min":300,"max":800}'::jsonb),
    ('budget.tiers', 'STANDARD', '舒适标准', 20, '{"icon":"✈️","description":"住宿、交通与体验均衡","min":800,"max":1500}'::jsonb),
    ('budget.tiers', 'QUALITY', '品质度假', 30, '{"icon":"🏨","description":"高品质酒店和特色体验","min":1500,"max":3000}'::jsonb),
    ('budget.tiers', 'LUXURY', '豪华旅行', 40, '{"icon":"💎","description":"豪华酒店、专车和私人体验","min":3000,"max":6000}'::jsonb),
    ('budget.tiers', 'CUSTOM', '自定义预算', 50, '{"icon":"⚙️","description":"适合有明确金额限制"}'::jsonb),
    ('budget.included_items', 'INTERCITY_TRANSPORT', '往返大交通', 10, '{}'::jsonb),
    ('budget.included_items', 'ACCOMMODATION', '住宿', 20, '{}'::jsonb),
    ('budget.included_items', 'MEALS', '餐饮', 30, '{}'::jsonb),
    ('budget.included_items', 'LOCAL_TRANSPORT', '市内交通', 40, '{}'::jsonb),
    ('budget.included_items', 'TICKETS', '门票与活动', 50, '{}'::jsonb),
    ('budget.included_items', 'SHOPPING', '购物', 60, '{}'::jsonb),
    ('budget.focus_tags', 'budget.lodging_quality', '预算侧重住宿品质', 10, '{}'::jsonb),
    ('budget.focus_tags', 'budget.unique_experience', '预算侧重特色体验', 20, '{}'::jsonb),
    ('budget.focus_tags', 'budget.transport_convenience', '预算侧重交通便利', 30, '{}'::jsonb),
    ('pace.intensity', '1', '躺平度假', 10, '{}'::jsonb),
    ('pace.intensity', '2', '常规慢逛', 20, '{}'::jsonb),
    ('pace.intensity', '3', '节奏均衡', 30, '{}'::jsonb),
    ('pace.intensity', '4', '充实紧凑', 40, '{}'::jsonb),
    ('pace.intensity', '5', '特种兵打卡', 50, '{}'::jsonb),
    ('pace.attractions_per_day', '1', '1 个', 10, '{}'::jsonb),
    ('pace.attractions_per_day', '2~3', '2~3 个', 20, '{}'::jsonb),
    ('pace.attractions_per_day', '4~5', '4~5 个', 30, '{}'::jsonb),
    ('pace.attractions_per_day', '尽可能多', '尽可能多', 40, '{}'::jsonb),
    ('pace.walking_limit_km', '2', '2 公里以内', 10, '{}'::jsonb),
    ('pace.walking_limit_km', '3', '3 公里以内', 20, '{}'::jsonb),
    ('pace.walking_limit_km', '5', '5 公里以内', 30, '{}'::jsonb),
    ('pace.walking_limit_km', '8', '8 公里以内', 40, '{}'::jsonb),
    ('pace.route_shape', 'hub', '中心辐射', 10, '{"glyph":"✳"}'::jsonb),
    ('pace.route_shape', 'single', '单点停留', 20, '{"glyph":"●"}'::jsonb),
    ('pace.route_shape', 'dual', '双中心', 30, '{"glyph":"●—●"}'::jsonb),
    ('pace.route_shape', 'multi', '多城市跳转', 40, '{"glyph":"●—●—●"}'::jsonb),
    ('pace.route_shape', 'loop', '环线自驾', 50, '{"glyph":"↻"}'::jsonb),
    ('pace.route_shape', 'oneway', '单向线路', 60, '{"glyph":"A→B"}'::jsonb),
    ('pace.route_shape', 'island', '跳岛', 70, '{"glyph":"● ● ●"}'::jsonb),
    ('pace.route_shape', 'improvise', '边走边定', 80, '{"glyph":"?"}'::jsonb),
    ('pace.need_tags', 'accessibility.wheelchair', '需轮椅通行', 10, '{}'::jsonb),
    ('pace.need_tags', 'accessibility.stroller', '需推车通行', 20, '{}'::jsonb),
    ('pace.need_tags', 'accessibility.low_walking', '步行量要少', 30, '{}'::jsonb),
    ('pace.need_tags', 'accessibility.child_car_seat', '需儿童安全座椅', 40, '{}'::jsonb),
    ('pace.need_tags', 'schedule.no_late_night', '不安排太晚的行程', 50, '{}'::jsonb),
    ('pace.need_tags', 'schedule.daily_rest', '每日固定午休', 60, '{}'::jsonb),
    ('transport.mode_tags', 'transport.public_transit', '优先公共交通', 10, '{}'::jsonb),
    ('transport.mode_tags', 'transport.self_drive', '自驾', 20, '{}'::jsonb),
    ('transport.mode_tags', 'transport.walking_first', '优先步行', 30, '{}'::jsonb),
    ('transport.mode_tags', 'transport.avoid_transfer', '尽量少换乘', 40, '{}'::jsonb),
    ('transport.mode_tags', 'transport.cycling', '单车出行', 50, '{}'::jsonb),
    ('transport.mode_tags', 'transport.rail', '铁路出行', 60, '{}'::jsonb),
    ('transport.lodging_type_tags', 'accommodation.hotel', '住酒店', 10, '{}'::jsonb),
    ('transport.lodging_type_tags', 'accommodation.homestay', '住民宿', 20, '{}'::jsonb),
    ('transport.lodging_type_tags', 'accommodation.apartment', '住公寓', 30, '{}'::jsonb),
    ('transport.lodging_type_tags', 'accommodation.resort', '住度假村', 40, '{}'::jsonb),
    ('transport.lodging_type_tags', 'accommodation.hostel', '住青年旅舍', 50, '{}'::jsonb),
    ('transport.lodging_requirement_tags', 'accommodation.elevator', '住宿有电梯', 10, '{}'::jsonb),
    ('transport.lodging_requirement_tags', 'accommodation.near_transit', '住宿靠近地铁或车站', 20, '{}'::jsonb),
    ('transport.lodging_requirement_tags', 'accommodation.private_bath', '独立卫浴', 30, '{}'::jsonb),
    ('transport.lodging_requirement_tags', 'accommodation.breakfast', '含早餐', 40, '{}'::jsonb),
    ('transport.lodging_requirement_tags', 'accommodation.kitchen', '带厨房', 50, '{}'::jsonb),
    ('transport.lodging_requirement_tags', 'accommodation.shared_dorm', '合住多人间', 60, '{}'::jsonb),
    ('diet.tags', 'diet.vegetarian', '素食', 10, '{}'::jsonb),
    ('diet.tags', 'diet.halal', '清真', 20, '{}'::jsonb),
    ('diet.tags', 'diet.no_spicy', '不吃辣', 30, '{}'::jsonb),
    ('diet.tags', 'diet.allergy_seafood', '海鲜过敏', 40, '{}'::jsonb),
    ('interest.tags', 'interest.history_culture', '历史与人文', 10, '{}'::jsonb),
    ('interest.tags', 'interest.nature', '自然风光', 20, '{}'::jsonb),
    ('interest.tags', 'interest.food', '本地美食', 30, '{}'::jsonb),
    ('interest.tags', 'interest.shopping', '购物', 40, '{}'::jsonb),
    ('interest.tags', 'interest.art_museum', '艺术与博物馆', 50, '{}'::jsonb),
    ('interest.tags', 'interest.nightlife', '夜间活动', 60, '{}'::jsonb),
    ('interest.tags', 'interest.photography', '摄影机位', 70, '{}'::jsonb),
    ('interest.tags', 'interest.family_kids', '亲子友好', 80, '{}'::jsonb),
    ('interest.tags', 'interest.city_walk', '城市漫步', 90, '{}'::jsonb),
    ('interest.tags', 'interest.cafe', '咖啡馆探店', 100, '{}'::jsonb),
    ('interest.tags', 'interest.hot_spring', '温泉体验', 110, '{}'::jsonb),
    ('interest.tags', 'interest.theme_park', '主题乐园', 120, '{}'::jsonb),
    ('interest.tags', 'interest.zoo_aquarium', '动物园与水族馆', 130, '{}'::jsonb),
    ('interest.tags', 'interest.light_hiking', '轻量徒步', 140, '{}'::jsonb),
    ('booking.existing', 'INTERCITY_TRANSPORT', '已有往返交通', 10, '{}'::jsonb),
    ('booking.existing', 'LODGING', '已有酒店', 20, '{}'::jsonb),
    ('booking.existing', 'TICKETS', '已有门票或演出', 30, '{}'::jsonb)
) AS seed(field_key, option_key, label, sort_order, metadata);
