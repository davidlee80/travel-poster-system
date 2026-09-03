import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

const here = path.dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  resolve: {
    alias: {
      '@': path.join(here, 'src'),
      // Workspace packages publish compiled output. Point tests at source so a
      // stale/locked dist directory cannot hide contract changes under test.
      '@tps/schemas': path.join(here, '../../packages/schemas/src/index.ts'),
    },
  },
  /*
   * JSX 用自动运行时。
   *
   * 项目的 tsconfig 是 `"jsx": "preserve"`（Next.js 自己编译 JSX），而 esbuild
   * 在 preserve 下回退到 classic 运行时 —— 于是 `.test.tsx` 里的 JSX 被编译成
   * `React.createElement` 而文件里没有 `import React`，报
   * `ReferenceError: React is not defined`。这不是「测试写错了」，
   * 而是两个编译器对同一份 tsconfig 的解释不同。
   */
  esbuild: { jsx: 'automatic' },
  test: {
    /*
     * 环境保持 `node`：这里的组件测试用 `react-dom/server` 渲染成静态 HTML
     * 再断言标记，不需要 DOM。引入 jsdom 会让另外 9 个纯逻辑测试文件
     * 也跑在一个用不到的浏览器模拟里。
     */
    include: ['src/**/*.test.ts', 'src/**/*.test.tsx'],
    environment: 'node',
  },
});
