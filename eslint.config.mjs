import js from '@eslint/js';
import tseslint from 'typescript-eslint';
import prettier from 'eslint-config-prettier';
import tpsLocal from './tools/eslint-rules/index.mjs';

export default tseslint.config(
  {
    ignores: [
      '**/node_modules/**',
      '**/dist/**',
      '**/.next/**',
      '**/.turbo/**',
      '**/coverage/**',
      '**/__visual__/**',
      'tools/eslint-rules/**', // 插件自身用 JSDoc 类型，不参与 TS 项目化 lint
    ],
  },

  js.configs.recommended,
  ...tseslint.configs.recommendedTypeChecked,
  prettier,

  {
    languageOptions: {
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
    plugins: {
      'tps-local': tpsLocal,
    },
    rules: {
      // R-14 / 22.3.3：跨平台路径护栏
      'tps-local/no-windows-path-separator': 'error',

      // 设计稿 22.3.3：任务入口不用 PowerShell，也不在代码里拼 shell
      'no-restricted-imports': [
        'error',
        {
          paths: [
            {
              name: 'child_process',
              message:
                '请使用 node:child_process；并确认命令在 Linux 容器内可执行（设计稿 22.3.3）。',
            },
          ],
        },
      ],

      // 设计稿二十章：凭据与个人数据禁止落日志。这里拦住最常见的误用形态。
      'no-restricted-properties': [
        'error',
        {
          object: 'console',
          property: 'log',
          message:
            '使用 @tps/shared 的结构化 logger，console.log 无法保证字段脱敏（设计稿 21.3、二十章）。',
        },
      ],

      '@typescript-eslint/consistent-type-imports': [
        'error',
        { prefer: 'type-imports', fixStyle: 'inline-type-imports' },
      ],
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_' },
      ],
      '@typescript-eslint/switch-exhaustiveness-check': 'error',
      '@typescript-eslint/no-floating-promises': 'error',
      '@typescript-eslint/no-misused-promises': 'error',
    },
  },

  // 测试文件放宽：允许 any 断言与非空断言，便于构造边界用例
  {
    files: ['**/*.test.ts', '**/*.spec.ts', '**/__tests__/**/*.ts'],
    rules: {
      '@typescript-eslint/no-explicit-any': 'off',
      '@typescript-eslint/no-non-null-assertion': 'off',
      '@typescript-eslint/no-unsafe-assignment': 'off',
      '@typescript-eslint/no-unsafe-member-access': 'off',
    },
  },

  // 构建脚本与配置文件：不做类型化 lint
  {
    files: ['**/*.mjs', '**/*.cjs', '**/*.config.{js,mjs,ts}'],
    ...tseslint.configs.disableTypeChecked,
  },
);
