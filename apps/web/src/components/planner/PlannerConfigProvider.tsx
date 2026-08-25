'use client';

import { createContext, useContext, useEffect, useMemo, useState } from 'react';

import { optionLabel } from '@/lib/planner/field-spec';
import type { OptionTarget } from '@/lib/planner/config-binding';
import { getPlannerConfig, type PlannerConfigResponse } from '@/lib/api-client';

/**
 * 配置中心在前端的落点。
 *
 * ## 首帧走内置值
 *
 * 配置在浏览器里拉（`useEffect`），因此服务端渲染的那一帧与水合后的第一帧
 * 用的是内置选项，配置到位后再换。代价是运营停用过的选项会闪一下；
 * 换成服务端取需要给 web 容器一份内部 API 地址与一次阻塞请求，
 * 而首页是这个应用的入口 —— 让它等一个可以回退的依赖不值得。
 *
 * ## 为什么解析器是「返回函数的 hook」而不是「返回选项的 hook」
 *
 * 一个对象数组字段的行摘要要为若干个行内部件各解析一次选项文案，
 * 而那发生在一个普通函数里（`rowSummary`）。如果 hook 直接返回某一个列表的
 * 选项，调用点就被 hook 规则绑死在组件顶层 —— 于是要么把 `rowSummary`
 * 改成组件（一个 `<p>` 里塞一个组件），要么在顶层为每个行内部件各调一次
 * hook（数量随描述符变化，违反 hook 顺序稳定）。
 *
 * 返回一个纯函数之后，一次 `useContext` 就能供整棵子树按需解析。
 */

const PlannerConfigContext = createContext<PlannerConfigResponse | null>(null);

export function PlannerConfigProvider({
  children,
  /** 测试注入。生产路径不传，走浏览器拉取 */
  value,
}: {
  readonly children: React.ReactNode;
  readonly value?: PlannerConfigResponse;
}) {
  const [fetched, setFetched] = useState<PlannerConfigResponse | null>(null);
  useEffect(() => {
    if (value !== undefined) return;
    let active = true;
    void getPlannerConfig().then((result) => {
      if (active && result.ok) setFetched(result.data);
    });
    return () => {
      active = false;
    };
  }, [value]);

  return (
    <PlannerConfigContext.Provider value={value ?? fetched}>
      {children}
    </PlannerConfigContext.Provider>
  );
}

export interface ResolvedOptions {
  /** 要渲染的选项值，顺序即展示顺序 */
  readonly values: readonly string[];
  readonly labelOf: (value: string) => string;
}

/**
 * 已经警告过的 field_key。
 *
 * 模块级而不是组件级：同一个列表在九步之间会被渲染很多次，
 * 每次渲染都打一行会让控制台被同一条消息淹没，而运营要找的是
 * 「哪些 key 被丢了」这份清单。
 */
const warned = new Set<string>();

/**
 * 选项解析器。给定载荷路径与内置值，返回实际要渲染的选项与文案。
 *
 * 四种情形：
 *
 *   1. 没有配置（还没拉到 / 拉失败） → 内置值 + 内置文案。页面照常可填。
 *   2. 配置里没有这个 field_key      → 同上。迁移漏注册一个列表是这种表现，
 *                                      由 `config-binding.test.ts` 的双向断言守住。
 *   3. `CONDITION_CODE`              → 用配置的列表，允许出现内置没有的码。
 *   4. `ENUM`                        → 配置 ∩ 内置。配置里多出来的值被丢弃 ——
 *                                      渲染它只会得到一个点了提交被 Zod 拒的按钮。
 */
export function usePlannerOptionResolver(): (target: OptionTarget) => ResolvedOptions {
  const config = useContext(PlannerConfigContext);

  return useMemo(() => {
    return ({ fieldKey, apiKey, values: builtIn, kind }) => {
      /* 回退文案按 api_key 查（`OPTION_LABEL` 的分层键），不是按更深的 fieldKey */
      const fallbackLabel = (value: string): string => optionLabel(value, apiKey);

      const published = config?.fields[fieldKey];
      if (published === undefined) return { values: builtIn, labelOf: fallbackLabel };

      const allowed = kind === 'ENUM' ? new Set<string>(builtIn) : null;
      const usable = allowed === null ? published : published.filter((o) => allowed.has(o.key));

      if (allowed !== null && usable.length !== published.length && !warned.has(fieldKey)) {
        warned.add(fieldKey);
        const dropped = published.filter((o) => !allowed.has(o.key)).map((o) => o.key);
        console.warn(
          `[planner-config] ${fieldKey} 是枚举字段，配置里的 ${dropped.join('、')} 不在契约枚举内，已忽略。` +
            '新增枚举成员需要同时改契约，只改配置不会生效。',
        );
      }

      const labels = new Map(usable.map((o) => [o.key, o.label]));
      return {
        values: usable.map((o) => o.key),
        /* 配置没给文案时回退内置：条件码列表可能出现内置文案表里也没有的新码 */
        labelOf: (value) => labels.get(value) ?? fallbackLabel(value),
      };
    };
  }, [config]);
}

/**
 * 右栏摘要用的文案解析器。
 *
 * 摘要拿到的是「字段的 api_key + 一个值」，而多部件字段的选项分散在
 * `api_key.部件键` 这些子路径下。因此这里按前缀在配置里找第一个能解释这个值的
 * 列表 —— 与今天 `OPTION_LABEL[apiKey]`（一个字段的全部选项文案挤在一张表里）
 * 的粒度完全一致，因此是行为等价而不是新引入的近似。
 */
export function useSummaryLabel(): (value: string, apiKey?: string) => string {
  const config = useContext(PlannerConfigContext);

  return useMemo(() => {
    if (config === null) return optionLabel;
    return (value, apiKey) => {
      if (apiKey !== undefined) {
        for (const [fieldKey, options] of Object.entries(config.fields)) {
          if (fieldKey !== apiKey && !fieldKey.startsWith(`${apiKey}.`)) continue;
          const hit = options.find((option) => option.key === value);
          if (hit !== undefined) return hit.label;
        }
      }
      return optionLabel(value, apiKey);
    };
  }, [config]);
}
