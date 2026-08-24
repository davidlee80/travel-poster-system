'use client';

import { createContext, useContext, useEffect, useMemo, useState } from 'react';

import {
  getPlannerConfig,
  type PlannerConfigOption,
  type PlannerConfigResponse,
} from '@/lib/api-client';

const PlannerConfigContext = createContext<PlannerConfigResponse | null>(null);

export function PlannerConfigProvider({ children }: { readonly children: React.ReactNode }) {
  const [config, setConfig] = useState<PlannerConfigResponse | null>(null);
  useEffect(() => {
    let active = true;
    void getPlannerConfig().then((result) => {
      if (active && result.ok) setConfig(result.data);
    });
    return () => {
      active = false;
    };
  }, []);
  return <PlannerConfigContext.Provider value={config}>{children}</PlannerConfigContext.Provider>;
}

/** API 不可用时使用代码内置值，页面仍可填写；成功后统一以发布版本为准。 */
export function usePlannerOptions(
  fieldKey: string,
  fallback: readonly PlannerConfigOption[],
): readonly PlannerConfigOption[] {
  const config = useContext(PlannerConfigContext);
  return useMemo(() => config?.fields[fieldKey] ?? fallback, [config, fieldKey, fallback]);
}

/**
 * 配置中心发布的条件码标签。
 *
 * `endsWith('tags')` 而不是 `endsWith('.tags')`：装条件码的 8 个 field_key
 * 命名不统一（`interest.tags` 与 `transport.mode_tags` 并存），
 * 而 `'.tags'` 会漏掉 `_tags` 结尾的五个 —— 于是配置中心改过文案的那些标签
 * 在界面上仍然显示内置文案，运营改了没生效。
 * 同一处缺陷在 `apps/api` 的 `isConditionCodeField` 里有完整说明，
 * 那一侧的后果严重得多（整个请求被 N-08 拒掉）。
 */
export function usePlannerConditionLabels(): Readonly<Record<string, string>> {
  const config = useContext(PlannerConfigContext);
  return useMemo(() => {
    if (config === null) return {};
    return Object.fromEntries(
      Object.entries(config.fields)
        .filter(([fieldKey]) => fieldKey.endsWith('tags'))
        .flatMap(([, options]) => options.map((option) => [option.key, option.label])),
    );
  }, [config]);
}
