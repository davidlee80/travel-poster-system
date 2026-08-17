import { describe, expect, it, vi } from 'vitest';

import { LlmConfigError } from './config.js';
import {
  AI_IMAGE_TIMEOUT_MS,
  FakeImageClient,
  HttpImageClient,
  ImageTimeoutError,
  ImageUnavailableError,
  createImageClient,
  imageWarningCode,
  loadImageConfig,
  type ImageRequest,
} from './image.js';

/**
 * 图片模型访问（TP-4-01/03，设计稿 11.1、21.2 措施二、13.7）。
 *
 * 两条断言值得单列：
 *   - **超时映射到告警码而不是错误码**（13.7：素材类错误全部非阻断）。
 *     搞错的表现是一次图片超时把整个已经生成好的计划变成 `FAILED`。
 *   - **`IMAGE_TIMEOUT_MS` 有上限**。允许配到 40 秒等于让一行配置静默推翻
 *     21.2 的 T2 目标，而违约只会表现为「偶发超时」。
 */

const request: ImageRequest = {
  prompt: 'illustration of 杭州',
  negativePrompt: 'no text, no logo',
  width: 1600,
  height: 600,
  seed: 918273,
  timeoutMs: AI_IMAGE_TIMEOUT_MS,
};

describe('FakeImageClient', () => {
  it('按请求渲染并回显种子，成本记 0', async () => {
    const client = new FakeImageClient((req) => new Uint8Array([req.width % 256]));
    const result = await client.generate(request);

    expect(result.bytes).toEqual(new Uint8Array([1600 % 256]));
    expect(result.seed).toBe(918273);
    expect(result.costUnits).toBe(0);
    expect(client.calls).toHaveLength(1);
    expect(client.calls[0]?.height).toBe(600);
  });

  it('渲染函数抛错时原样抛出，供降级链处理', async () => {
    const client = new FakeImageClient(() => {
      throw new ImageUnavailableError('注入故障');
    });
    await expect(client.generate(request)).rejects.toThrow(ImageUnavailableError);
  });
});

describe('13.7 错误映射', () => {
  it('超时 → ASSET_AI_GENERATION_TIMEOUT', () => {
    expect(imageWarningCode(new ImageTimeoutError(20_000))).toBe('ASSET_AI_GENERATION_TIMEOUT');
  });

  it('其余一律 ASSET_AI_GENERATION_FAILED（含未知异常）', () => {
    expect(imageWarningCode(new ImageUnavailableError('HTTP 500'))).toBe(
      'ASSET_AI_GENERATION_FAILED',
    );
    expect(imageWarningCode(new Error('???'))).toBe('ASSET_AI_GENERATION_FAILED');
  });
});

describe('HttpImageClient', () => {
  function okResponse(b64: string): Response {
    return new Response(JSON.stringify({ data: [{ b64_json: b64 }], model: 'sd-3.5' }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  }

  it('请求体带尺寸、种子、负向提示与 b64_json', async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(okResponse('AQID'));
    const client = new HttpImageClient({
      baseUrl: 'https://images.example.com/',
      apiKey: 'k',
      model: 'sd-3.5',
      fetchImpl,
    });

    const result = await client.generate(request);

    const [url, init] = fetchImpl.mock.calls[0] ?? [];
    expect(url).toBe('https://images.example.com/v1/images/generations');
    const raw = init?.body;
    expect(typeof raw).toBe('string');
    const body = JSON.parse(raw as string) as Record<string, unknown>;
    expect(body).toMatchObject({
      model: 'sd-3.5',
      size: '1600x600',
      seed: 918273,
      negative_prompt: 'no text, no logo',
      response_format: 'b64_json',
      n: 1,
    });
    expect(result.bytes).toEqual(new Uint8Array([1, 2, 3]));
    expect(result.costUnits).toBe(1);
  });

  it('网关模式带业务标识头', async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(okResponse('AQID'));
    await new HttpImageClient({
      baseUrl: 'https://gw.example.com',
      apiKey: 'k',
      model: 'm',
      gateway: true,
      fetchImpl,
    }).generate(request);

    const headers = (fetchImpl.mock.calls[0]?.[1]?.headers ?? {}) as Record<string, string>;
    expect(headers['x-tps-service']).toBe('travel-poster-system');
  });

  it('超时抛 ImageTimeoutError', async () => {
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockRejectedValue(Object.assign(new Error('timed out'), { name: 'TimeoutError' }));
    const client = new HttpImageClient({ baseUrl: 'x', apiKey: 'k', model: 'm', fetchImpl });
    await expect(client.generate(request)).rejects.toThrow(ImageTimeoutError);
  });

  it('错误信息只带状态码，不回显响应体（二十章）', async () => {
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValue(new Response('prompt 里的目的地是杭州', { status: 400 }));
    const client = new HttpImageClient({ baseUrl: 'x', apiKey: 'k', model: 'm', fetchImpl });

    await expect(client.generate(request)).rejects.toThrow('HTTP 400');
    await expect(client.generate(request)).rejects.not.toThrow(/杭州/);
  });

  it('解码后为空时报错，而不是把空图片送进后处理', async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(okResponse('!!!'));
    const client = new HttpImageClient({ baseUrl: 'x', apiKey: 'k', model: 'm', fetchImpl });
    await expect(client.generate(request)).rejects.toThrow(/解码后为空/);
  });
});

describe('配置', () => {
  it('缺省为 fake 模式，超时取 20 秒', () => {
    expect(loadImageConfig({})).toEqual({
      mode: 'fake',
      model: '',
      baseUrl: '',
      apiKey: '',
      timeoutMs: AI_IMAGE_TIMEOUT_MS,
    });
  });

  it('direct / gateway 模式下三项必填', () => {
    expect(() => loadImageConfig({ IMAGE_MODE: 'direct' })).toThrow(LlmConfigError);
    expect(() =>
      loadImageConfig({ IMAGE_MODE: 'gateway', IMAGE_GATEWAY_URL: 'u', IMAGE_API_KEY: 'k' }),
    ).toThrow(/IMAGE_MODEL/);
  });

  it('gateway 模式读 IMAGE_GATEWAY_URL，不读 IMAGE_BASE_URL', () => {
    const config = loadImageConfig({
      IMAGE_MODE: 'gateway',
      IMAGE_BASE_URL: 'https://direct.example.com',
      IMAGE_GATEWAY_URL: 'https://gw.example.com',
      IMAGE_API_KEY: 'k',
      IMAGE_MODEL: 'm',
    });
    expect(config.baseUrl).toBe('https://gw.example.com');
  });

  it('超时不得超过 20 秒（21.2 措施二不可被配置推翻）', () => {
    expect(() => loadImageConfig({ IMAGE_TIMEOUT_MS: '40000' })).toThrow(/20000/);
    expect(loadImageConfig({ IMAGE_TIMEOUT_MS: '8000' }).timeoutMs).toBe(8_000);
  });

  it('fake 模式未提供渲染函数时生成必然失败（降级链因此可测）', async () => {
    const client = createImageClient(loadImageConfig({}));
    await expect(client.generate(request)).rejects.toThrow(ImageUnavailableError);
  });
});
