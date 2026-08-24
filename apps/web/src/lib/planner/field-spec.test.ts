import {
  AGE_BAND_VALUES,
  ALLERGY_SEVERITY_VALUES,
  BED_TYPE_VALUES,
  BUDGET_MODE_VALUES,
  BUDGET_SCOPE_ITEM_VALUES,
  CABIN_CLASS_VALUES,
  CAR_TYPE_VALUES,
  CHANGEABILITY_VALUES,
  CHILD_NEED_VALUES,
  CONNECTIVITY_PREFERENCE_VALUES,
  CORE_ACTIVITIES_VALUES,
  CURRENCY_VALUES,
  DATE_FLEXIBILITY_VALUES,
  DEPARTURE_WINDOW_VALUES,
  DESTINATION_STATUS_VALUES,
  DIETARY_REQUIREMENT_VALUES,
  DINING_BUDGET_VALUES,
  DRIVING_EXPERIENCE_VALUES,
  ESIM_SUPPORT_VALUES,
  FOOD_EXPERIENCE_VALUES,
  FREE_TIME_VALUES,
  GROUPING_NEED_VALUES,
  HEALTH_NEED_VALUES,
  HIGH_RISK_ACTIVITY_VALUES,
  HOTEL_CHANGE_TOLERANCE_VALUES,
  HOTEL_CLASS_VALUES,
  INSURANCE_STATUS_VALUES,
  LARGE_LUGGAGE_VALUES,
  LICENSE_STATUS_VALUES,
  LOCATION_PRIORITY_VALUES,
  LOCATION_SHARING_VALUES,
  LOCKED_ORDER_TYPE_VALUES,
  LOYALTY_KIND_VALUES,
  MINOR_GUARDIANSHIP_VALUES,
  MOBILITY_LEVEL_VALUES,
  MONITORING_TOPIC_VALUES,
  NOTIFICATION_CHANNEL_VALUES,
  NOTIFICATION_MODE_VALUES,
  PASSPORT_STATUS_VALUES,
  PAYMENT_METHOD_VALUES,
  PLANNER_FIELDS,
  QUEUE_ATTITUDE_VALUES,
  RISK_EXCLUSION_VALUES,
  SAFETY_CONTEXT_VALUES,
  SEAT_PREFERENCE_VALUES,
  SLEEP_CHECKIN_NEED_VALUES,
  TOP_GOAL_VALUES,
  TRANSFER_TOLERANCE_VALUES,
  TRAVEL_TIER_VALUES,
  TRAVELER_RELATION_VALUES,
  TRIP_PURPOSE_VALUES,
  TRISTATE_ANSWER_VALUES,
  VISA_STATUS_VALUES,
  WALKING_TOLERANCE_VALUES,
} from '@tps/schemas';
import { describe, expect, it } from 'vitest';

import { ABSTRACT_SUMMARY, OPTION_LABEL, optionLabel } from './field-spec';

/**
 * api_key → 该字段选项文案应当覆盖的枚举值。
 *
 * 这张表存在的唯一理由：**枚举值改名不会让任何东西报错**。
 * 契约里把 `NO_ALCOHOL` 改成 `ALCOHOL_FREE` 之后，文案表里那一条就永远查不到，
 * 而界面上表现为一个显示 `ALCOHOL_FREE` 的复选框 —— 没有报错、没有空白，
 * 只是一个英文标签，很容易在自测里被当成「还没做完」而放过去。
 *
 * 复合字段（一个 api_key 下有多组枚举，如舱等 + 座位）把几组拼起来。
 */
const EXPECTED: Record<string, readonly string[]> = {
  'trip.destination_status': DESTINATION_STATUS_VALUES,
  'trip.date_flexibility': DATE_FLEXIBILITY_VALUES,
  'trip.locked_order_types': LOCKED_ORDER_TYPE_VALUES,
  'trip.locked_orders': [...LOCKED_ORDER_TYPE_VALUES, ...CHANGEABILITY_VALUES],
  /*
   * 同行关系与年龄段共用一个 api_key 下的文案表，且 `CHILD` 是两者的公共成员。
   * `Set` 去重后再比较 —— 不去重会让「每个枚举值都有文案」这条断言
   * 把同一个 `CHILD` 查两次（无害），但让「没有死文案」那条把它算成
   * 一个只出现一次的键对两个来源（也无害）。写成显式的并集是为了让
   * 下一个读这里的人不必推理这件事。
   */
  'travelers.profiles': [...new Set([...TRAVELER_RELATION_VALUES, ...AGE_BAND_VALUES])],
  'profile.trip_purposes': TRIP_PURPOSE_VALUES,
  'profile.top_goals': TOP_GOAL_VALUES,
  'travelers.minor_guardianship': MINOR_GUARDIANSHIP_VALUES,
  'travelers.mobility_level': MOBILITY_LEVEL_VALUES,
  'travelers.child_needs': CHILD_NEED_VALUES,
  'travelers.grouping_needs': GROUPING_NEED_VALUES,
  'budget.mode': BUDGET_MODE_VALUES,
  'budget.currency': CURRENCY_VALUES,
  'budget.travel_tier': TRAVEL_TIER_VALUES,
  'budget.scope_and_priorities': BUDGET_SCOPE_ITEM_VALUES,
  'pace.walking_tolerance': WALKING_TOLERANCE_VALUES,
  'pace.core_activities_per_day': CORE_ACTIVITIES_VALUES,
  'pace.free_time': FREE_TIME_VALUES,
  'pace.hotel_change_tolerance': HOTEL_CHANGE_TOLERANCE_VALUES,
  'risk.exclusions': RISK_EXCLUSION_VALUES,
  'transport.flight_constraints': TRANSFER_TOLERANCE_VALUES,
  'transport.flight_comfort': [...CABIN_CLASS_VALUES, ...SEAT_PREFERENCE_VALUES],
  'transport.time_preferences': DEPARTURE_WINDOW_VALUES,
  'transport.self_drive': [
    ...DRIVING_EXPERIENCE_VALUES,
    ...LICENSE_STATUS_VALUES,
    ...CAR_TYPE_VALUES,
  ],
  'transport.luggage_profile': LARGE_LUGGAGE_VALUES,
  'lodging.room_configuration': BED_TYPE_VALUES,
  'lodging.location_priorities': LOCATION_PRIORITY_VALUES,
  'lodging.class_and_brand': HOTEL_CLASS_VALUES,
  'lodging.sleep_checkin_needs': SLEEP_CHECKIN_NEED_VALUES,
  'food.experience_tags': FOOD_EXPERIENCE_VALUES,
  'food.dietary_requirements': DIETARY_REQUIREMENT_VALUES,
  'food.has_allergies': TRISTATE_ANSWER_VALUES,
  'food.allergy_details': ALLERGY_SEVERITY_VALUES,
  'food.dining_style': [...DINING_BUDGET_VALUES, ...QUEUE_ATTITUDE_VALUES],
  'special.has_health_or_accessibility_needs': TRISTATE_ANSWER_VALUES,
  'special.health_accessibility_needs': HEALTH_NEED_VALUES,
  'special.high_risk_activities': HIGH_RISK_ACTIVITY_VALUES,
  'special.medication_status': TRISTATE_ANSWER_VALUES,
  'documents.passport_status': PASSPORT_STATUS_VALUES,
  'documents.visa_status': VISA_STATUS_VALUES,
  'insurance.status': INSURANCE_STATUS_VALUES,
  'safety.contexts': SAFETY_CONTEXT_VALUES,
  'service.notification_preferences': [...NOTIFICATION_MODE_VALUES, ...NOTIFICATION_CHANNEL_VALUES],
  'service.monitoring_topics': MONITORING_TOPIC_VALUES,
  'pretrip.connectivity': [...ESIM_SUPPORT_VALUES, ...CONNECTIVITY_PREFERENCE_VALUES],
  'pretrip.payment_methods': PAYMENT_METHOD_VALUES,
  'pretrip.loyalty_programs': LOYALTY_KIND_VALUES,
  'pretrip.emergency_contact': LOCATION_SHARING_VALUES,
};

describe('选项文案表与契约枚举一致', () => {
  it('每个枚举值都有中文文案', () => {
    const missing: string[] = [];
    for (const [apiKey, values] of Object.entries(EXPECTED)) {
      for (const value of values) {
        if (OPTION_LABEL[apiKey]?.[value] === undefined) missing.push(`${apiKey}.${value}`);
      }
    }
    expect(missing).toEqual([]);
  });

  it('没有指向不存在枚举值的文案 —— 那条文案永远不会被显示', () => {
    const dead: string[] = [];
    for (const [apiKey, values] of Object.entries(EXPECTED)) {
      const allowed = new Set<string>(values);
      for (const value of Object.keys(OPTION_LABEL[apiKey] ?? {})) {
        if (!allowed.has(value)) dead.push(`${apiKey}.${value}`);
      }
    }
    expect(dead).toEqual([]);
  });

  it('文案表里的 api_key 都是 76 字段之一', () => {
    /* `Set<string>` 而不是让它推成 76 个字面量的联合 —— 这里比较的是运行期字符串 */
    const known = new Set<string>(PLANNER_FIELDS.map((spec) => spec.api_key));
    const unknown = Object.keys(OPTION_LABEL).filter((apiKey) => !known.has(apiKey));
    expect(unknown).toEqual([]);
  });

  it('同名枚举值在不同字段下给出不同文案 —— 这是分层的全部理由', () => {
    /*
     * `SHOPPING` 出现在四个字段里。扁平表会静默取其中一个，
     * 而症状是「第 1 步显示购物，第 6 步也显示购物」——
     * 两个问题看起来问了同一件事。
     */
    expect(optionLabel('SHOPPING', 'profile.trip_purposes')).toBe('购物');
    expect(optionLabel('SHOPPING', 'profile.top_goals')).toBe('购物效率');
    expect(optionLabel('SHOPPING', 'budget.scope_and_priorities')).toBe('购物开支');
    expect(optionLabel('SHOPPING', 'lodging.location_priorities')).toBe('购物方便');
  });

  it('条件码转发给 @tps/presentation 的编译期表', () => {
    expect(optionLabel('diet.alcohol_free')).toBe('不饮酒');
    expect(optionLabel('transport.private_car', 'transport.local_modes')).toBe('包车');
  });

  it('查不到时回退原值 —— 空标签看起来像渲染错误，英文标签能看出是漏配', () => {
    expect(optionLabel('SOMETHING_NEW', 'budget.mode')).toBe('SOMETHING_NEW');
  });
});

describe('敏感字段的抽象摘要', () => {
  it('每个会出现在右栏的高度敏感字段都有抽象文案', () => {
    /*
     * 范围是「高度敏感 **且** 摘要分组不是不展示」。少了后半个条件会要求给
     * 授权、紧急联系人、导入文件三个字段配文案 —— 而它们在 buildSummary 里
     * 更早就被跳过，那三条文案永远不会被显示。
     *
     * 少了前半个条件（只看会不会出现在右栏）则会把 70 个普通字段都算进来。
     */
    const missing = PLANNER_FIELDS.filter(
      (spec) =>
        spec.sensitivity === 'HIGH' &&
        spec.summary_group !== 'HIDDEN' &&
        ABSTRACT_SUMMARY[spec.field_id] === undefined,
    ).map((spec) => `${spec.field_id} ${spec.api_key}`);
    expect(missing).toEqual([]);
  });

  it('抽象文案里不含具体值的字样', () => {
    /* 抽象摘要的用途是「有这件事」而不是「这件事的内容」*/
    for (const text of Object.values(ABSTRACT_SUMMARY)) {
      expect(text).not.toMatch(/[0-9]{4}-[0-9]{2}-[0-9]{2}/);
    }
  });

  it('没有给非高度敏感字段配抽象文案 —— 那会让它的具体值无声消失', () => {
    /*
     * `isMasked` 只看 `sensitivity === 'HIGH'`，因此给「敏感」级字段配文案
     * 是死代码；而如果哪天有人把 isMasked 放宽到「敏感」，这些字段的具体值
     * 会在右栏突然变成「已登记 XX」，且没有任何测试会红。
     */
    const overreach = Object.keys(ABSTRACT_SUMMARY).filter((fieldId) => {
      const spec = PLANNER_FIELDS.find((entry) => entry.field_id === fieldId);
      return spec === undefined || spec.sensitivity !== 'HIGH' || spec.summary_group === 'HIDDEN';
    });
    expect(overreach).toEqual([]);
  });
});
