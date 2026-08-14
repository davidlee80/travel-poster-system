import noWindowsPathSeparator from './no-windows-path-separator.mjs';

/**
 * 仓库本地 ESLint 插件。
 *
 * 只放"设计稿明确要求、且现成规则无法表达"的约束。
 * 能用 TypeScript 类型表达的约束一律不写成 lint 规则 —— 类型检查在编译期强制，
 * 比 lint 更难绕过（例：禁止 user_id 作为指标标签，见 packages/observability）。
 */
const plugin = {
  meta: {
    name: 'eslint-plugin-tps-local',
    version: '0.0.0',
  },
  rules: {
    'no-windows-path-separator': noWindowsPathSeparator,
  },
};

export default plugin;
