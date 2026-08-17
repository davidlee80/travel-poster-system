/**
 * 身份模块的对外入口。
 *
 * 只为端到端集成测试而存在（见 package.json 的 exports 说明）：
 * TP-2-17 的验收点跨 API 与 Worker 两侧，而把两侧装进同一个测试是唯一能
 * 自动验证「接缝」的方式 —— 各自的单测都只覆盖自己那一半。
 */

export { IdentityService } from './service.js';
export type {
  CookieMutation,
  Identity,
  IdentityKind,
  IdentityServiceDeps,
  LoginResult,
  RegisterResult,
  ResolveInput,
  ResolveResult,
} from './service.js';
export { InMemorySessionStore, SESSION_TTL_SECONDS } from './session-store.js';
export type { CreatedSession, SessionStore } from './session-store.js';
export { RedisSessionStore } from './redis-session-store.js';
