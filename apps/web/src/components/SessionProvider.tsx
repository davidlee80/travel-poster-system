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
 * 启动时调一次 `/auth/session`。开关打开（R-13 的双模式）时，无身份的访客
 * 会被服务端自动建匿名号并下发 Cookie，因此那一次调用同时完成「取身份」与
 * 「建身份」；**P7 关闭匿名入口后**，同一次调用返回 401 ——
 * 那是正常的「未登录」状态，不是故障。
 *
 * `status` 四态而不是 `session | null`：
 *   loading    首次请求未完成 —— 此时不能显示「未登录」，否则已登录用户
 *              每次刷新都会看到一闪而过的登录按钮
 *   ready      有身份（注册；开关打开时也可能是匿名）
 *   anonymous  服务端拒绝了未注册请求（401）—— **必须与 error 分开**：
 *              把它显示成「服务出错了」会让访客去刷新页面而不是去注册，
 *              而刷新一万次也不会有身份
 *   error      连不上后端或 5xx —— 与「未登录」必须区分，否则会把服务故障
 *              显示成「你还没登录」，用户会去点登录然后再次失败
 */

export type SessionStatus =
  | { readonly kind: 'loading' }
  | { readonly kind: 'ready'; readonly session: SessionInfo }
  | { readonly kind: 'anonymous' }
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
    if (result.ok) {
      setStatus({ kind: 'ready', session: result.data });
      return;
    }

    /*
     * 401 是「未注册」而不是「出错了」（P7）。
     *
     * 按 HTTP 状态码判断而不是按错误码字符串：401 这一类的语义在 13.0 里是
     * 稳定的（无身份 / 身份无效），而错误码集合会随迭代增加 ——
     * 漏掉一个新码的表现是把「未登录」显示成「服务故障」。
     */
    setStatus(
      result.status === 401 ? { kind: 'anonymous' } : { kind: 'error', message: result.message },
    );
  }, []);

  const logout = useCallback(async () => {
    await apiLogout();
    /*
     * 登出后不重新签发匿名令牌（13.9.3），因此重新取一次身份。
     * 开关打开时服务端会为这次访问建一个新的匿名身份；
     * P7 关闭后这一次会拿到 401，于是落到 `anonymous` 态 —— 正是我们要的
     * 「登出后回到未登录」，不需要为登出单开一条分支。
     */
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
