'use client';

import { useEffect, useRef, useState, type FormEvent } from 'react';

import { login, register, sendVerificationCode } from '@/lib/api-client';
import { PasswordChangeForm } from './PasswordChangeForm';
import { useSession } from './SessionProvider';

type Mode = 'register' | 'login';
type LoginMethod = 'CODE' | 'PASSWORD';

export function AuthPanel(): React.ReactElement {
  const { status, setSession, logout } = useSession();
  const rootRef = useRef<HTMLDivElement>(null);
  const [open, setOpen] = useState(false);
  const [mode, setMode] = useState<Mode>('login');
  const [loginMethod, setLoginMethod] = useState<LoginMethod>('CODE');
  const [phone, setPhone] = useState('');
  const [verificationCode, setVerificationCode] = useState('');
  const [password, setPassword] = useState('');
  const [displayName, setDisplayName] = useState('');
  const [error, setError] = useState<{ message: string; field?: string } | null>(null);
  const [pending, setPending] = useState(false);
  const [sendingCode, setSendingCode] = useState(false);
  const [countdown, setCountdown] = useState(0);
  const [devHint, setDevHint] = useState<string | null>(null);
  const [changingPassword, setChangingPassword] = useState(false);

  useEffect(() => {
    const closeFromOutside = (event: PointerEvent): void => {
      if (rootRef.current?.contains(event.target as Node) === false) setOpen(false);
    };
    const closeFromEscape = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') setOpen(false);
    };
    document.addEventListener('pointerdown', closeFromOutside);
    document.addEventListener('keydown', closeFromEscape);
    return () => {
      document.removeEventListener('pointerdown', closeFromOutside);
      document.removeEventListener('keydown', closeFromEscape);
    };
  }, []);

  useEffect(() => {
    if (countdown <= 0) return;
    const timer = window.setInterval(() => setCountdown((value) => Math.max(0, value - 1)), 1_000);
    return () => window.clearInterval(timer);
  }, [countdown]);

  useEffect(() => {
    const openFromHash = (): void => {
      if (window.location.hash !== '#auth-phone') return;
      setOpen(true);
      window.requestAnimationFrame(() => document.getElementById('auth-phone')?.focus());
    };
    window.addEventListener('hashchange', openFromHash);
    openFromHash();
    return () => window.removeEventListener('hashchange', openFromHash);
  }, [status.kind]);

  const session = status.kind === 'ready' ? status.session : null;
  const registered = session !== null && session.user_type === 'REGISTERED';
  const maskedPhone = session?.phone?.replace(/^(\+86)?(\d{3})\d{4}(\d{4})$/, '$1 $2****$3');
  const userName = registered
    ? (session.display_name ?? maskedPhone ?? session.email ?? '旅行者')
    : '用户登录';
  const avatarText = userName.trim().slice(0, 1).toUpperCase() || 'U';
  const needsCode = mode === 'register' || loginMethod === 'CODE';

  const sendCode = async (): Promise<void> => {
    if (sendingCode || countdown > 0) return;
    if (!/^(?:\+?86)?1[3-9]\d{9}$/.test(phone.trim())) {
      setError({ message: '请输入正确的中国大陆手机号。', field: 'phone' });
      return;
    }
    setError(null);
    setSendingCode(true);
    const result = await sendVerificationCode({
      phone: phone.trim(),
      purpose: mode === 'register' ? 'REGISTER' : 'LOGIN',
    });
    setSendingCode(false);
    if (!result.ok) {
      setError({ message: result.message, ...(result.field ? { field: result.field } : {}) });
      return;
    }
    setCountdown(60);
    if (result.data.dev_code !== undefined) {
      setVerificationCode(result.data.dev_code);
      setDevHint(`本地测试验证码已自动填入：${result.data.dev_code}`);
    } else {
      setDevHint('验证码已发送，5 分钟内有效。');
    }
  };

  const submit = async (event: FormEvent): Promise<void> => {
    event.preventDefault();
    if (pending) return;
    setError(null);
    setPending(true);
    const result =
      mode === 'register'
        ? await register({
            phone: phone.trim(),
            verificationCode,
            ...(password.length > 0 ? { password } : {}),
            ...(displayName.trim().length > 0 ? { displayName: displayName.trim() } : {}),
          })
        : await login({
            phone: phone.trim(),
            method: loginMethod,
            credential: loginMethod === 'CODE' ? verificationCode : password,
          });
    setPending(false);
    if (result.ok) {
      setSession(result.data);
      setPassword('');
      setVerificationCode('');
      setDevHint(null);
      setOpen(false);
      return;
    }
    setError({ message: result.message, ...(result.field ? { field: result.field } : {}) });
    if (result.code === 'AUTH_PHONE_ALREADY_REGISTERED') setMode('login');
  };

  return (
    <div className="planner-user" ref={rootRef}>
      <button
        id="user-menu"
        type="button"
        className="planner-user__trigger"
        aria-haspopup="dialog"
        aria-expanded={open}
        onClick={() => setOpen((value) => !value)}
      >
        <span className="planner-user__avatar" aria-hidden="true">
          {registered ? avatarText : '人'}
        </span>
        <span className="planner-user__meta">
          <strong>{userName}</strong>
          <small>{registered ? '查看账号与额度' : '登录后保存旅行计划'}</small>
        </span>
        <span className="planner-user__chevron" aria-hidden="true">
          ⌄
        </span>
      </button>

      {open ? (
        <div className="planner-user__popover" role="dialog" aria-label="用户登录">
          {status.kind === 'loading' ? (
            <p className="planner-user__status">正在加载登录状态…</p>
          ) : status.kind === 'error' ? (
            <p className="auth-panel__error" role="alert">
              {status.message}
            </p>
          ) : registered ? (
            <div className="planner-user__account">
              <div className="planner-user__profile">
                <span
                  className="planner-user__avatar planner-user__avatar--large"
                  aria-hidden="true"
                >
                  {avatarText}
                </span>
                <div>
                  <strong>{userName}</strong>
                  <span>{maskedPhone ?? session.email}</span>
                </div>
              </div>
              <div className="planner-user__quota">
                <div>
                  <strong>{session.quota.daily_remaining}</strong>
                  <span>今日剩余</span>
                </div>
                <div>
                  <strong>{session.quota.monthly_remaining}</strong>
                  <span>本月剩余</span>
                </div>
              </div>
              <div className="planner-user__actions">
                {session.has_password ? (
                  <button
                    type="button"
                    className="auth-panel__link"
                    aria-expanded={changingPassword}
                    onClick={() => setChangingPassword((value) => !value)}
                  >
                    {changingPassword ? '收起密码设置' : '修改密码'}
                  </button>
                ) : null}
                <button
                  type="button"
                  className="auth-panel__link auth-panel__link--danger"
                  onClick={() => {
                    setOpen(false);
                    void logout();
                  }}
                >
                  退出登录
                </button>
              </div>
              {changingPassword ? (
                <PasswordChangeForm onDone={() => setChangingPassword(false)} />
              ) : null}
            </div>
          ) : (
            <form className="auth-panel auth-panel--form" onSubmit={(event) => void submit(event)}>
              <div className="planner-user__form-head">
                <strong>{mode === 'login' ? '手机号登录' : '手机号快速注册'}</strong>
                <span>保存计划，并可在其他设备继续查看</span>
              </div>
              <div className="auth-panel__tabs" role="tablist">
                {(['login', 'register'] as const).map((item) => (
                  <button
                    key={item}
                    type="button"
                    role="tab"
                    aria-selected={mode === item}
                    className={mode === item ? 'auth-panel__tab is-active' : 'auth-panel__tab'}
                    onClick={() => {
                      setMode(item);
                      setError(null);
                      setDevHint(null);
                    }}
                  >
                    {item === 'login' ? '登录账号' : '快速注册'}
                  </button>
                ))}
              </div>

              {mode === 'login' ? (
                <div
                  className="auth-panel__tabs auth-panel__tabs--secondary"
                  role="tablist"
                  aria-label="登录方式"
                >
                  <button
                    type="button"
                    role="tab"
                    aria-selected={loginMethod === 'CODE'}
                    className={
                      loginMethod === 'CODE' ? 'auth-panel__tab is-active' : 'auth-panel__tab'
                    }
                    onClick={() => {
                      setLoginMethod('CODE');
                      setError(null);
                    }}
                  >
                    验证码登录
                  </button>
                  <button
                    type="button"
                    role="tab"
                    aria-selected={loginMethod === 'PASSWORD'}
                    className={
                      loginMethod === 'PASSWORD' ? 'auth-panel__tab is-active' : 'auth-panel__tab'
                    }
                    onClick={() => {
                      setLoginMethod('PASSWORD');
                      setError(null);
                    }}
                  >
                    密码登录
                  </button>
                </div>
              ) : null}

              <label className="auth-panel__field">
                <span>手机号</span>
                <input
                  id="auth-phone"
                  type="tel"
                  required
                  inputMode="numeric"
                  autoComplete="tel"
                  placeholder="请输入 11 位手机号"
                  value={phone}
                  onChange={(event) => setPhone(event.target.value)}
                  aria-invalid={error?.field === 'phone'}
                />
              </label>

              {needsCode ? (
                <div className="auth-panel__field">
                  <span>短信验证码</span>
                  <div className="auth-panel__code-row">
                    <input
                      type="text"
                      required
                      inputMode="numeric"
                      autoComplete="one-time-code"
                      maxLength={6}
                      placeholder="6 位验证码"
                      value={verificationCode}
                      onChange={(event) =>
                        setVerificationCode(event.target.value.replace(/\D/g, ''))
                      }
                      aria-invalid={error?.field === 'verification_code'}
                    />
                    <button
                      type="button"
                      className="auth-panel__send-code"
                      disabled={sendingCode || countdown > 0}
                      onClick={() => void sendCode()}
                    >
                      {sendingCode ? '发送中…' : countdown > 0 ? `${countdown}s` : '获取验证码'}
                    </button>
                  </div>
                  {devHint !== null ? <small className="auth-panel__hint">{devHint}</small> : null}
                </div>
              ) : (
                <label className="auth-panel__field">
                  <span>密码</span>
                  <input
                    type="password"
                    required
                    autoComplete="current-password"
                    value={password}
                    onChange={(event) => setPassword(event.target.value)}
                    aria-invalid={error?.field === 'password'}
                  />
                </label>
              )}

              {mode === 'register' ? (
                <>
                  <label className="auth-panel__field">
                    <span>
                      设置登录密码 <em>（可选）</em>
                    </span>
                    <input
                      type="password"
                      minLength={password.length > 0 ? 10 : undefined}
                      autoComplete="new-password"
                      value={password}
                      onChange={(event) => setPassword(event.target.value)}
                      aria-invalid={error?.field === 'password'}
                    />
                    <small className="auth-panel__hint">
                      不填写也可注册，以后可继续使用短信验证码登录
                    </small>
                  </label>
                  <label className="auth-panel__field">
                    <span>
                      昵称 <em>（可选）</em>
                    </span>
                    <input
                      type="text"
                      maxLength={100}
                      autoComplete="nickname"
                      value={displayName}
                      onChange={(event) => setDisplayName(event.target.value)}
                    />
                  </label>
                </>
              ) : null}

              {error !== null ? (
                <p className="auth-panel__error" role="alert">
                  {error.message}
                </p>
              ) : null}
              <button type="submit" className="auth-panel__submit" disabled={pending}>
                {pending ? '处理中…' : mode === 'register' ? '注册并保存计划' : '登录'}
              </button>
              {mode === 'register' ? (
                <p className="auth-panel__legal">
                  注册即表示你已阅读并同意
                  <a href="/legal" target="_blank" rel="noopener noreferrer">
                    《用户协议与隐私政策》
                  </a>
                  。
                </p>
              ) : null}
            </form>
          )}
        </div>
      ) : null}
    </div>
  );
}
