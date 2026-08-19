'use client';

import { useState, type FormEvent } from 'react';
import { login, register } from '@/lib/api-client';
import { useSession } from './SessionProvider';

/**
 * 注册 / 登录 / 登出界面（TP-1-40，设计稿 13.9）。
 *
 * ## 两处与后端契约对齐的细节
 *
 * 1. **注册按钮对匿名用户显示为「保存我的计划」**而不是「注册」。
 *    匿名用户此刻已有计划，注册的实际收益是「让它们长期保存」——
 *    用「注册」会让人以为要从头再来。
 *
 * 2. **错误提示直接用后端的 `message`**，不在前端另写一套文案。
 *    后端的错误码表（13.7）已经保证了提示不含内部细节，
 *    前端再翻译一遍只会产生两套不一致的说法。
 */

type Mode = 'register' | 'login';

export function AuthPanel() {
  const { status, setSession, logout } = useSession();

  const [mode, setMode] = useState<Mode>('register');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [displayName, setDisplayName] = useState('');
  const [error, setError] = useState<{ message: string; field?: string } | null>(null);
  const [pending, setPending] = useState(false);

  if (status.kind === 'loading') {
    return <div className="auth-panel auth-panel--loading">正在加载…</div>;
  }

  if (status.kind === 'error') {
    // 与「未登录」严格区分：把服务故障显示成未登录会让用户去点登录然后再次失败
    return (
      <div className="auth-panel auth-panel--error" role="alert">
        {status.message}
      </div>
    );
  }

  /*
   * P7：`anonymous` 态（服务端拒绝了未注册请求）与「匿名身份」在这里的
   * 呈现完全相同 —— 都是「显示注册/登录表单」。因此只在需要读身份字段时
   * 才区分两者，其余分支共用。
   */
  const session = status.kind === 'ready' ? status.session : null;

  if (session !== null && session.user_type === 'REGISTERED') {
    return (
      <div className="auth-panel">
        <div className="auth-panel__who">
          <span className="auth-panel__name">{session.display_name ?? session.email}</span>
          <span className="auth-panel__quota">本月剩余 {session.quota.monthly_remaining} 次</span>
        </div>
        <button type="button" className="auth-panel__link" onClick={() => void logout()}>
          退出登录
        </button>
      </div>
    );
  }

  const submit = async (event: FormEvent): Promise<void> => {
    event.preventDefault();
    setError(null);
    setPending(true);

    const result =
      mode === 'register'
        ? await register({
            email,
            password,
            ...(displayName.trim().length > 0 ? { displayName: displayName.trim() } : {}),
          })
        : await login({ email, password });

    setPending(false);

    if (result.ok) {
      setSession(result.data);
      setPassword('');
      return;
    }

    // 直接用后端文案（13.7 已保证不含内部细节）
    setError({ message: result.message, ...(result.field ? { field: result.field } : {}) });

    // 邮箱已注册时自动切到登录 —— 这是用户下一步唯一想做的事
    if (result.code === 'AUTH_EMAIL_ALREADY_REGISTERED') {
      setMode('login');
    }
  };

  return (
    <form className="auth-panel auth-panel--form" onSubmit={(e) => void submit(e)}>
      <div className="auth-panel__tabs" role="tablist">
        <button
          type="button"
          role="tab"
          aria-selected={mode === 'register'}
          className={mode === 'register' ? 'auth-panel__tab is-active' : 'auth-panel__tab'}
          onClick={() => {
            setMode('register');
            setError(null);
          }}
        >
          保存我的计划
        </button>
        <button
          type="button"
          role="tab"
          aria-selected={mode === 'login'}
          className={mode === 'login' ? 'auth-panel__tab is-active' : 'auth-panel__tab'}
          onClick={() => {
            setMode('login');
            setError(null);
          }}
        >
          已有账号
        </button>
      </div>

      <label className="auth-panel__field">
        <span>邮箱</span>
        <input
          type="email"
          required
          autoComplete="email"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          aria-invalid={error?.field === 'email'}
        />
      </label>

      <label className="auth-panel__field">
        <span>密码</span>
        <input
          type="password"
          required
          minLength={10}
          autoComplete={mode === 'register' ? 'new-password' : 'current-password'}
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          aria-invalid={error?.field === 'password'}
        />
        {mode === 'register' && (
          <small className="auth-panel__hint">至少 10 个字符，不必包含特殊符号</small>
        )}
      </label>

      {mode === 'register' && (
        <label className="auth-panel__field">
          <span>
            昵称 <em>（可选）</em>
          </span>
          <input
            type="text"
            maxLength={100}
            autoComplete="nickname"
            value={displayName}
            onChange={(e) => setDisplayName(e.target.value)}
          />
        </label>
      )}

      {error !== null && (
        <p className="auth-panel__error" role="alert">
          {error.message}
        </p>
      )}

      <button type="submit" className="auth-panel__submit" disabled={pending}>
        {pending ? '处理中…' : mode === 'register' ? '注册并保存计划' : '登录'}
      </button>

      {mode === 'register' && (
        <p className="auth-panel__note">注册后当前访客身份下已生成的计划会自动保留。</p>
      )}
    </form>
  );
}
