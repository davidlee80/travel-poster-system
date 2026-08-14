'use client';

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from 'react';
import { getSession, logout as apiLogout, type SessionInfo } from '@/lib/api-client';

/**
 * 身份上下文（TP-1-40，设计稿 13.9.1）。
 *
 * 启动时调一次 `/auth/session` —— 无身份时服务端会自动建匿名号并下发 Cookie，
 * 因此这一次调用同时完成了「取身份」与「建身份」。
 *
 * `status` 三态而不是 `session | null`：
 *   loading  首次请求未完成 —— 此时不能显示「未登录」，否则已登录用户
 *            每次刷新都会看到一闪而过的登录按钮
 *   ready    有身份（匿名或注册）
 *   error    连不上后端 —— 与「匿名身份」必须区分，否则会把服务故障
 *            显示成「你还没登录」，用户会去点登录然后再次失败
 */

export type SessionStatus =
  | { readonly kind: 'loading' }
  | { readonly kind: 'ready'; readonly session: SessionInfo }
  | { readonly kind: 'error'; readonly message: string };

interface SessionContextValue {
  readonly status: SessionStatus;
  readonly refresh: () => Promise<void>;
  readonly setSession: (session: SessionInfo) => void;
  readonly logout: () => Promise<void>;
}

const SessionContext = createContext<SessionContextValue | null>(null);

export function SessionProvider({ children }: { readonly children: ReactNode }) {
  const [status, setStatus] = useState<SessionStatus>({ kind: 'loading' });

  const refresh = useCallback(async () => {
    const result = await getSession();
    setStatus(
      result.ok
        ? { kind: 'ready', session: result.data }
        : { kind: 'error', message: result.message },
    );
  }, []);

  const logout = useCallback(async () => {
    await apiLogout();
    // 登出后不重新签发匿名令牌（13.9.3），因此重新取一次身份 ——
    // 服务端会为这次访问建一个新的匿名身份
    await refresh();
  }, [refresh]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const value = useMemo<SessionContextValue>(
    () => ({
      status,
      refresh,
      setSession: (session) => setStatus({ kind: 'ready', session }),
      logout,
    }),
    [status, refresh, logout],
  );

  return <SessionContext.Provider value={value}>{children}</SessionContext.Provider>;
}

export function useSession(): SessionContextValue {
  const context = useContext(SessionContext);
  if (context === null) {
    throw new Error('useSession 必须在 SessionProvider 内使用');
  }
  return context;
}
