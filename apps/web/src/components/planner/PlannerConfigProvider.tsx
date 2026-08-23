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

export function usePlannerConditionLabels(): Readonly<Record<string, string>> {
  const config = useContext(PlannerConfigContext);
  return useMemo(() => {
    if (config === null) return {};
    return Object.fromEntries(
      Object.entries(config.fields)
        .filter(([fieldKey]) => fieldKey.endsWith('.tags'))
        .flatMap(([, options]) => options.map((option) => [option.key, option.label])),
    );
  }, [config]);
}
