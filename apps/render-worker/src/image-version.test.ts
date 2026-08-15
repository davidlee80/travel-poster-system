import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * Playwright 库版本与镜像 tag 必须一致（TP-1-10、TP-1-17）。
 *
 * ## 为什么值得一条测试
 *
 * 官方 Playwright 镜像里的浏览器目录名带构建号（`/ms-playwright/chromium-1234`），
 * 由镜像的 Playwright 版本决定。库版本与镜像不一致时报的是
 *
 *   Executable doesn't exist at /ms-playwright/chromium-1234/chrome-linux/chrome
 *
 * 这条信息里没有「版本不匹配」四个字，第一反应通常是去查镜像有没有装浏览器。
 * 而触发它只需要一次例行的 `pnpm update` —— 依赖升级的 diff 里根本不会
 * 出现 Dockerfile。
 */

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, '..', '..', '..');

const dockerfile = await readFile(
  path.join(repoRoot, 'deploy', 'images', 'render-worker.Dockerfile'),
  'utf8',
);
const packageJson = JSON.parse(await readFile(path.join(here, '..', 'package.json'), 'utf8')) as {
  dependencies: Record<string, string>;
};

describe('Playwright 版本同步', () => {
  it('package.json 里的 playwright-core 是精确版本', () => {
    /*
     * 用 ^ 或 ~ 会让 pnpm 在锁文件更新时把库升到镜像没有的版本，
     * 而这条同步检查就永远比实际情况滞后一步。精确版本让升级必须是显式动作。
     */
    const range = packageJson.dependencies['playwright-core'];
    expect(range, 'playwright-core 未声明为依赖').toBeDefined();
    expect(range, `playwright-core 应固定为精确版本，当前是 ${range}`).toMatch(/^\d+\.\d+\.\d+$/);
  });

  it('Dockerfile 的 PLAYWRIGHT_VERSION 与库版本一致', () => {
    const match = /^ARG PLAYWRIGHT_VERSION=(.+)$/m.exec(dockerfile);
    expect(match?.[1], 'Dockerfile 未声明 ARG PLAYWRIGHT_VERSION').toBeDefined();
    expect(match![1]!.trim()).toBe(packageJson.dependencies['playwright-core']);
  });

  it('运行层的 FROM 使用该 ARG，而不是又写一遍版本号', () => {
    // 写死第二遍就等于有两个真相源，这条测试也就管不住其中一个
    expect(dockerfile).toMatch(
      /FROM mcr\.microsoft\.com\/playwright:v\$\{PLAYWRIGHT_VERSION\}-jammy/,
    );
  });
});

describe('渲染镜像的 Linux 约束（22.3.1、22.3.2）', () => {
  it('系统级安装完整 Noto CJK（R-15）', () => {
    expect(dockerfile).toContain('fonts-noto-cjk');
  });

  it('构建期断言 fc-list 能查到 Noto（L-04）', () => {
    // 只 apt install 不验证是不够的：包名改动或 apt 源缺包时安装会「成功」
    // 而字体并未落地，运行期表现是豆腐块
    expect(dockerfile).toMatch(/fc-cache/);
    expect(dockerfile).toMatch(/grep -ci noto/);
  });

  it('构建期加载一次 sharp（L-05）', () => {
    expect(dockerfile).toMatch(/require\('sharp'\)/);
  });

  it('以数值 UID 10001 运行且用 tini 作为 PID 1', () => {
    /*
     * 数值 UID：用名字（node/pwuser）在某些 K8s runAsUser 校验下不生效（22.3.1）。
     * tini：Chromium 会产生僵尸子进程，无 init 会持续累积直到进程表耗尽。
     */
    expect(dockerfile).toMatch(/USER 10001:10001/);
    expect(dockerfile).toMatch(/ENTRYPOINT \["\/usr\/bin\/tini"/);
  });

  it('不含 --no-sandbox', () => {
    expect(dockerfile).not.toContain('--no-sandbox');
  });
});
