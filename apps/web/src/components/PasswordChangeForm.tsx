'use client';

import { useState, type FormEvent } from 'react';
import { changePassword } from '@/lib/api-client';

/**
 * 改密码表单（13.9.2）。
 *
 * ## 为什么有「确认新密码」而注册表单没有
 *
 * 注册时把口令打错了，用户会在下一次登录失败时发现，而邮箱还在手上 ——
 * 最坏的结果是重新注册一个。改密码打错则**直接锁死账号**：新口令是错的、
 * 旧口令已失效，而 V1 没有邮件发送能力，自助找回不存在。
 * 这两个字段的比较是纯前端校验，服务端没有对应规则，因此不存在双真相源问题。
 *
 * ## 为什么必须写出「其他设备会退出登录」
 *
 * 服务端会吊销该账号的全部会话（见 `IdentityService.changePassword`）。
 * 这是用户改口令时**想要**的效果，但不说出来就是个意外 ——
 * 手机上那个登录态突然没了，用户不会联想到十分钟前在电脑上改过密码。
 */

export interface PasswordChangeFormProps {
  /** 改成功后由父组件收起表单 */
  readonly onDone: () => void;
}

export function PasswordChangeForm({ onDone }: PasswordChangeFormProps) {
  const [current, setCurrent] = useState('');
  const [next, setNext] = useState('');
  const [confirm, setConfirm] = useState('');
  const [error, setError] = useState<{ message: string; field?: string } | null>(null);
  const [pending, setPending] = useState(false);
  const [done, setDone] = useState(false);

  const submit = async (event: FormEvent): Promise<void> => {
    event.preventDefault();
    if (pending) return;

    if (next !== confirm) {
      // 这一条不发请求：两次输入不一致时服务端无从判断哪一个是用户想要的
      setError({ message: '两次输入的新密码不一致。', field: 'confirm' });
      return;
    }

    setError(null);
    setPending(true);
    const result = await changePassword({ currentPassword: current, newPassword: next });
    setPending(false);

    if (result.ok) {
      setCurrent('');
      setNext('');
      setConfirm('');
      setDone(true);
      return;
    }

    // 直接用后端文案（13.7 已保证不含内部细节）
    setError({ message: result.message, ...(result.field ? { field: result.field } : {}) });
  };

  if (done) {
    return (
      <div className="auth-panel__done" role="status">
        <p>密码已修改。其他设备上的登录已全部退出，这台设备不用重新登录。</p>
        <button type="button" className="auth-panel__link" onClick={onDone}>
          好
        </button>
      </div>
    );
  }

  return (
    <form className="auth-panel__subform" onSubmit={(e) => void submit(e)}>
      <label className="auth-panel__field">
        <span>当前密码</span>
        <input
          type="password"
          required
          autoComplete="current-password"
          value={current}
          onChange={(e) => setCurrent(e.target.value)}
          aria-invalid={error?.field === 'current_password'}
        />
      </label>

      <label className="auth-panel__field">
        <span>新密码</span>
        <input
          type="password"
          required
          minLength={10}
          autoComplete="new-password"
          value={next}
          onChange={(e) => setNext(e.target.value)}
          aria-invalid={error?.field === 'new_password'}
        />
        <small className="auth-panel__hint">至少 10 个字符，不必包含特殊符号</small>
      </label>

      <label className="auth-panel__field">
        <span>确认新密码</span>
        <input
          type="password"
          required
          autoComplete="new-password"
          value={confirm}
          onChange={(e) => setConfirm(e.target.value)}
          aria-invalid={error?.field === 'confirm'}
        />
      </label>

      {error !== null && (
        <p className="auth-panel__error" role="alert">
          {error.message}
        </p>
      )}

      <p className="auth-panel__hint">
        修改后<strong>其他设备上的登录会全部退出</strong>，这台设备不用重新登录。
      </p>

      <div className="auth-panel__row">
        <button type="submit" className="auth-panel__submit" disabled={pending}>
          {pending ? '处理中…' : '确认修改'}
        </button>
        <button type="button" className="auth-panel__link" onClick={onDone}>
          取消
        </button>
      </div>
    </form>
  );
}
