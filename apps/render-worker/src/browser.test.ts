import { describe, expect, it } from 'vitest';

import { chromiumArgs, checkDevShm, DEVICE_SCALE_FACTOR, RENDER_VIEWPORT } from './browser.js';

describe('Chromium 启动参数（TP-1-19）', () => {
  const noFallback = { availableBytes: null, needsFallback: false, reason: '测试' } as const;
  const withFallback = {
    availableBytes: 64 * 1048576,
    needsFallback: true,
    reason: '测试',
  } as const;

  it('不使用 --no-sandbox', () => {
    /*
     * 22.3.2 要求「优先用 seccomp profile 保留沙箱」。
     *
     * 页面里含 LLM 产出的文本与外部图片 URL，沙箱是这条链路上唯一阻止
     * 「渲染引擎漏洞 → 容器内任意代码执行」的机制。加 --no-sandbox 让
     * 一切照常工作，因此不会有任何人察觉它被加上了 —— 只能靠断言拦住。
     */
    expect(chromiumArgs(noFallback)).not.toContain('--no-sandbox');
    expect(chromiumArgs(noFallback)).not.toContain('--disable-setuid-sandbox');
  });

  it('固定字体渲染，保证视觉基线可复现', () => {
    const args = chromiumArgs(noFallback);
    // hinting 会按字号做像素级微调，不同 Chromium 版本结果不同
    expect(args).toContain('--font-render-hinting=none');
    expect(args).toContain('--disable-lcd-text');
  });

  it('/dev/shm 充足时不加降级参数', () => {
    // 该参数把共享内存写到磁盘，明显更慢；单次渲染预算只有 5 秒（17.3），
    // 常态开启会白白吃掉一大截
    expect(chromiumArgs(noFallback)).not.toContain('--disable-dev-shm-usage');
  });

  it('/dev/shm 不足时加降级参数', () => {
    expect(chromiumArgs(withFallback)).toContain('--disable-dev-shm-usage');
  });

  it('关闭后台节流', () => {
    // 节流会让 requestAnimationFrame 停摆，就绪探针（17.2）因此永远超时
    const args = chromiumArgs(noFallback);
    expect(args).toContain('--disable-background-timer-throttling');
    expect(args).toContain('--disable-renderer-backgrounding');
  });
});

describe('checkDevShm（TP-1-18）', () => {
  it('非 Linux 平台不降级', () => {
    /*
     * Windows / macOS 的 Chromium 不使用 /dev/shm。在开发机上强行降级会让
     * 本地渲染与容器行为不一致 —— 而我们恰恰指望本地能复现容器的问题。
     */
    const status = checkDevShm();

    if (process.platform === 'linux') {
      // 在 Linux 上跑时只断言结构，容量取决于宿主
      expect(typeof status.needsFallback).toBe('boolean');
      expect(status.reason.length).toBeGreaterThan(0);
    } else {
      expect(status.needsFallback).toBe(false);
      expect(status.availableBytes).toBeNull();
      expect(status.reason).toContain(process.platform);
    }
  });
});

describe('导出尺寸（17.4）', () => {
  it('viewport 1200 宽、2 倍图', () => {
    // 17.4 的这两个数决定输出宽度 2400px。改动它们会让全部视觉基线失效，
    // 且产物看起来正常、只是打印时糊 —— 因此写成断言而不只是常量
    expect(RENDER_VIEWPORT.width).toBe(1200);
    expect(RENDER_VIEWPORT.height).toBe(1600);
    expect(DEVICE_SCALE_FACTOR).toBe(2);
  });
});
