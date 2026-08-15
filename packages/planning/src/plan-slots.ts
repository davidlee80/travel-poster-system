import type { Currency, TravelPlanContent } from '@tps/schemas';

/**
 * 计划内所有「同类字段」的统一遍历（TP-2-12）。
 *
 * ## 为什么要有这一层
 *
 * V-23（币种一致）、V-24（金额非负且两位小数）、V-40（长度）、V-44（空串与
 * Markdown 残留）、V-45（URL 与 HTML）都是「对全文所有字符串／所有金额生效」
 * 的规则。若每条规则各自写一遍递归，`TravelPlan` 新增一个字段时就要改五处，
 * 漏掉任何一处的表现是**该字段永远逃过清洗** —— 而 V-45 正是 1.2
 * 「模型不生成 HTML」的执行点，逃过它意味着模型输出的 `<script>` 能一路
 * 走到渲染层。
 *
 * 因此这里做一次显式遍历，产出带路径与写回能力的「槽位」，五条规则共用。
 *
 * ## 为什么是显式枚举而不是通用递归
 *
 * 通用递归（遍历所有 own property）无法区分「必须非空」与「允许为空」——
 * 而这个区分决定 V-44 报 `BLOCKING` 还是 `REPAIRABLE`（`title` 为空是致命的，
 * `subtitle` 为空只是难看）。它也无法区分「金额」与「时长／坐标」，
 * 那会让 V-24 把 `duration_minutes: 150` 也当成金额去检查两位小数。
 * 显式枚举的代价是新增字段要来加一行，收益是这些区分在类型与代码里都可见。
 */

export interface StringSlot {
  /** 点分路径，直接用于 `PlanViolation.path` */
  readonly path: string;
  /**
   * 是否对应 `NonEmptyStringSchema`。
   *
   * V-44 的分级依据：必填字段被清洗成空串是 `BLOCKING`（升级），
   * 可空字段为空只是内容缺失，`REPAIRABLE`。
   */
  readonly required: boolean;
  get(): string;
  set(next: string): void;
}

export interface NumberSlot {
  readonly path: string;
  get(): number;
  set(next: number): void;
}

export interface CurrencySlot {
  readonly path: string;
  get(): Currency;
  set(next: Currency): void;
}

function stringSlot(path: string, required: boolean, target: { value: string }): StringSlot {
  return {
    path,
    required,
    get: () => target.value,
    set: (next) => {
      target.value = next;
    },
  };
}

/**
 * 全部字符串槽位。
 *
 * `place_id` 也收进来（非 null 时）：它虽然是标识符而不是文案，但同样来自
 * 模型输出，而它会进缓存键与数据库。V-45 不覆盖它就等于给 HTML 留了一个
 * 侧门。它是可空字段，因此 `required: false`。
 */
export function collectStringSlots(plan: TravelPlanContent): StringSlot[] {
  const slots: StringSlot[] = [];

  const push = (path: string, required: boolean, target: { value: string }): void => {
    slots.push(stringSlot(path, required, target));
  };

  push('title', true, {
    get value() {
      return plan.title;
    },
    set value(next: string) {
      plan.title = next;
    },
  });
  push('summary', false, {
    get value() {
      return plan.summary;
    },
    set value(next: string) {
      plan.summary = next;
    },
  });
  push('destination.name', true, {
    get value() {
      return plan.destination.name;
    },
    set value(next: string) {
      plan.destination.name = next;
    },
  });
  if (plan.destination.place_id !== null) {
    push('destination.place_id', false, {
      get value() {
        return plan.destination.place_id ?? '';
      },
      set value(next: string) {
        plan.destination.place_id = next;
      },
    });
  }

  plan.days.forEach((day, d) => {
    const dayPath = `days[${d}]`;

    push(`${dayPath}.city`, true, {
      get value() {
        return day.city;
      },
      set value(next: string) {
        day.city = next;
      },
    });
    push(`${dayPath}.theme`, true, {
      get value() {
        return day.theme;
      },
      set value(next: string) {
        day.theme = next;
      },
    });
    push(`${dayPath}.subtitle`, false, {
      get value() {
        return day.subtitle;
      },
      set value(next: string) {
        day.subtitle = next;
      },
    });
    push(`${dayPath}.daily_summary`, false, {
      get value() {
        return day.daily_summary;
      },
      set value(next: string) {
        day.daily_summary = next;
      },
    });

    day.schedule.forEach((item, s) => {
      const itemPath = `${dayPath}.schedule[${s}]`;
      push(`${itemPath}.title`, true, {
        get value() {
          return item.title;
        },
        set value(next: string) {
          item.title = next;
        },
      });
      push(`${itemPath}.description`, false, {
        get value() {
          return item.description;
        },
        set value(next: string) {
          item.description = next;
        },
      });
      push(`${itemPath}.location.name`, true, {
        get value() {
          return item.location.name;
        },
        set value(next: string) {
          item.location.name = next;
        },
      });
      if (item.location.place_id !== null) {
        push(`${itemPath}.location.place_id`, false, {
          get value() {
            return item.location.place_id ?? '';
          },
          set value(next: string) {
            item.location.place_id = next;
          },
        });
      }
    });

    day.food_recommendations.forEach((food, f) => {
      const foodPath = `${dayPath}.food_recommendations[${f}]`;
      push(`${foodPath}.name`, true, {
        get value() {
          return food.name;
        },
        set value(next: string) {
          food.name = next;
        },
      });
      push(`${foodPath}.description`, false, {
        get value() {
          return food.description;
        },
        set value(next: string) {
          food.description = next;
        },
      });
    });

    day.route_recommendations.forEach((route, r) => {
      const routePath = `${dayPath}.route_recommendations[${r}]`;
      push(`${routePath}.title`, true, {
        get value() {
          return route.title;
        },
        set value(next: string) {
          route.title = next;
        },
      });
      route.nodes.forEach((_node, n) => {
        push(`${routePath}.nodes[${n}]`, true, {
          get value() {
            return route.nodes[n] ?? '';
          },
          set value(next: string) {
            route.nodes[n] = next;
          },
        });
      });
    });

    day.must_do.forEach((_entry, m) => {
      push(`${dayPath}.must_do[${m}]`, true, {
        get value() {
          return day.must_do[m] ?? '';
        },
        set value(next: string) {
          day.must_do[m] = next;
        },
      });
    });

    day.photo_spots.forEach((spot, p) => {
      const spotPath = `${dayPath}.photo_spots[${p}]`;
      push(`${spotPath}.name`, true, {
        get value() {
          return spot.name;
        },
        set value(next: string) {
          spot.name = next;
        },
      });
      push(`${spotPath}.entity_name`, true, {
        get value() {
          return spot.entity_name;
        },
        set value(next: string) {
          spot.entity_name = next;
        },
      });
    });

    day.transport_tips.forEach((tip, t) => {
      push(`${dayPath}.transport_tips[${t}].text`, true, {
        get value() {
          return tip.text;
        },
        set value(next: string) {
          tip.text = next;
        },
      });
    });

    day.ticket_reminders.forEach((reminder, t) => {
      const reminderPath = `${dayPath}.ticket_reminders[${t}]`;
      push(`${reminderPath}.entity_name`, true, {
        get value() {
          return reminder.entity_name;
        },
        set value(next: string) {
          reminder.entity_name = next;
        },
      });
      push(`${reminderPath}.text`, true, {
        get value() {
          return reminder.text;
        },
        set value(next: string) {
          reminder.text = next;
        },
      });
    });

    day.booking_tips.forEach((tip, b) => {
      push(`${dayPath}.booking_tips[${b}].text`, true, {
        get value() {
          return tip.text;
        },
        set value(next: string) {
          tip.text = next;
        },
      });
    });

    day.daily_budget.breakdown.forEach((entry, b) => {
      push(`${dayPath}.daily_budget.breakdown[${b}].label`, true, {
        get value() {
          return entry.label;
        },
        set value(next: string) {
          entry.label = next;
        },
      });
    });
  });

  plan.constraint_report.satisfied.forEach((entry, i) => {
    push(`constraint_report.satisfied[${i}].code`, true, {
      get value() {
        return entry.code;
      },
      set value(next: string) {
        entry.code = next;
      },
    });
    push(`constraint_report.satisfied[${i}].evidence`, false, {
      get value() {
        return entry.evidence;
      },
      set value(next: string) {
        entry.evidence = next;
      },
    });
  });

  plan.constraint_report.violated.forEach((entry, i) => {
    push(`constraint_report.violated[${i}].code`, true, {
      get value() {
        return entry.code;
      },
      set value(next: string) {
        entry.code = next;
      },
    });
    push(`constraint_report.violated[${i}].reason`, false, {
      get value() {
        return entry.reason;
      },
      set value(next: string) {
        entry.reason = next;
      },
    });
  });

  plan.constraint_report.assumptions.forEach((entry, i) => {
    push(`constraint_report.assumptions[${i}].code`, true, {
      get value() {
        return entry.code;
      },
      set value(next: string) {
        entry.code = next;
      },
    });
    push(`constraint_report.assumptions[${i}].text`, true, {
      get value() {
        return entry.text;
      },
      set value(next: string) {
        entry.text = next;
      },
    });
  });

  return slots;
}

/**
 * 全部「非负数值量」槽位（V-24）。
 *
 * 3.2.1 的原文是「所有金额 >= 0 且为整数或两位小数」。这里同时收进
 * `estimated_walking_km`：它同样是模型产出的非负数值量，而**没有任何一条
 * 规则覆盖它** —— V-08 管坐标、V-24 管金额、V-11 只做求和比较（负数会让
 * 总和变小从而通过）。漏掉的表现是 ViewModel 上出现「-1.2 km」。
 * 见设计稿修订 R-22。
 *
 * `duration_minutes` 不在其中：它由 V-07 以「与时间差一致」的方式校验，
 * 那是比「两位小数」更强的约束，收进来只会产生重复违规。
 */
export function collectAmountSlots(plan: TravelPlanContent): NumberSlot[] {
  const slots: NumberSlot[] = [];

  const push = (path: string, target: { value: number }): void => {
    slots.push({
      path,
      get: () => target.value,
      set: (next) => {
        target.value = next;
      },
    });
  };

  const total = plan.total_budget;
  const totalKeys = [
    'ticket',
    'transport',
    'meal',
    'accommodation',
    'other',
    'total',
    'per_person',
  ] as const;
  for (const key of totalKeys) {
    push(`total_budget.${key}`, {
      get value() {
        return total[key];
      },
      set value(next: number) {
        total[key] = next;
      },
    });
  }

  plan.days.forEach((day, d) => {
    const budget = day.daily_budget;
    const dailyKeys = ['ticket', 'transport', 'meal', 'other', 'total'] as const;
    for (const key of dailyKeys) {
      push(`days[${d}].daily_budget.${key}`, {
        get value() {
          return budget[key];
        },
        set value(next: number) {
          budget[key] = next;
        },
      });
    }

    budget.breakdown.forEach((entry, b) => {
      push(`days[${d}].daily_budget.breakdown[${b}].amount`, {
        get value() {
          return entry.amount;
        },
        set value(next: number) {
          entry.amount = next;
        },
      });
    });

    day.schedule.forEach((item, s) => {
      push(`days[${d}].schedule[${s}].estimated_cost.amount`, {
        get value() {
          return item.estimated_cost.amount;
        },
        set value(next: number) {
          item.estimated_cost.amount = next;
        },
      });
      push(`days[${d}].schedule[${s}].estimated_walking_km`, {
        get value() {
          return item.estimated_walking_km;
        },
        set value(next: number) {
          item.estimated_walking_km = next;
        },
      });
    });

    day.ticket_reminders.forEach((reminder, t) => {
      push(`days[${d}].ticket_reminders[${t}].price.amount`, {
        get value() {
          return reminder.price.amount;
        },
        set value(next: number) {
          reminder.price.amount = next;
        },
      });
    });
  });

  return slots;
}

/** 全部币种槽位（V-23） */
export function collectCurrencySlots(plan: TravelPlanContent): CurrencySlot[] {
  const slots: CurrencySlot[] = [];

  const push = (path: string, target: { value: Currency }): void => {
    slots.push({
      path,
      get: () => target.value,
      set: (next) => {
        target.value = next;
      },
    });
  };

  push('currency', {
    get value() {
      return plan.currency;
    },
    set value(next: Currency) {
      plan.currency = next;
    },
  });
  push('total_budget.currency', {
    get value() {
      return plan.total_budget.currency;
    },
    set value(next: Currency) {
      plan.total_budget.currency = next;
    },
  });

  plan.days.forEach((day, d) => {
    push(`days[${d}].daily_budget.currency`, {
      get value() {
        return day.daily_budget.currency;
      },
      set value(next: Currency) {
        day.daily_budget.currency = next;
      },
    });

    day.schedule.forEach((item, s) => {
      push(`days[${d}].schedule[${s}].estimated_cost.currency`, {
        get value() {
          return item.estimated_cost.currency;
        },
        set value(next: Currency) {
          item.estimated_cost.currency = next;
        },
      });
    });

    day.ticket_reminders.forEach((reminder, t) => {
      push(`days[${d}].ticket_reminders[${t}].price.currency`, {
        get value() {
          return reminder.price.currency;
        },
        set value(next: Currency) {
          reminder.price.currency = next;
        },
      });
    });
  });

  return slots;
}
