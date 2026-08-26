import { describe, expect, it, vi } from 'vitest';

import { LlmConfigError } from './config.js';
import {
  AI_IMAGE_PREHEAT_TIMEOUT_MS,
  AI_IMAGE_TIMEOUT_MS,
  DEFAULT_IMAGE_JOB_AI_BUDGET_MS,
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
    });
    expect(result.bytes).toEqual(new Uint8Array([1, 2, 3]));
    expect(result.costUnits).toBe(1);
  });

  it('不传 n —— 它零收益，却让 Gemini 系图片模型整类不可用', async () => {
    /*
     * 这条断言原本是 `n: 1`。改成「不能有」是因为 ofox 明确警告
     * `google/*-image-*` 不接受这个参数（它们是 generateContent 模型，
     * 只返回单图）。而 OpenAI 的 `n` 默认就是 1 —— 传与不传等价。
     *
     * 断言「不存在」而不是删掉这条测试：删了的话下一次有人把 n 加回来
     * （它看起来那么无害）不会有任何东西拦他，而症状是 Gemini 候选全部 4xx。
     */
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(okResponse('AQID'));
    await new HttpImageClient({
      baseUrl: 'https://api.ofox.ai',
      apiKey: 'sk-of-test',
      model: 'google/gemini-3-pro-image',
      fetchImpl,
    }).generate(request);

    const body = JSON.parse(fetchImpl.mock.calls[0]?.[1]?.body as string) as Record<
      string,
      unknown
    >;
    expect(body).not.toHaveProperty('n');
    // 同时钉住 ofox 的 images 端点拼接
    expect(fetchImpl.mock.calls[0]?.[0]).toBe('https://api.ofox.ai/v1/images/generations');
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
  it('缺省为 fake 模式，三个时间参数各有默认值', () => {
    expect(loadImageConfig({})).toEqual({
      mode: 'fake',
      model: '',
      baseUrl: '',
      apiKey: '',
      timeoutMs: AI_IMAGE_TIMEOUT_MS,
      preheatTimeoutMs: AI_IMAGE_PREHEAT_TIMEOUT_MS,
      jobAiBudgetMs: DEFAULT_IMAGE_JOB_AI_BUDGET_MS,
    });
  });

  it('direct / gateway 模式下三项必填', () => {
    expect(() => loadImageConfig({ IMAGE_MODE: 'direct' })).toThrow(LlmConfigError);
    expect(() =>
      loadImageConfig({ IMAGE_MODE: 'gateway', IMAGE_GATEWAY_URL: 'u', IMAGE_API_KEY: 'k' }),
    ).toThrow(/IMAGE_MODEL/);
  });

  it('base 带 /v1 尾缀时启动即失败（与 LLM 侧同一条规则）', () => {
    /*
     * 图片端同样自己拼 `/v1/images/generations`。照 ofox 文档填
     * `https://api.ofox.ai/v1` 会打到 `/v1/v1/images/generations`，
     * 而图片类错误是**告警级**的（13.7）—— 症状会是「AI 素材全部降级成占位图」，
     * 比文本侧的失败更容易被当成模型质量问题而不是配置问题。
     */
    expect(() =>
      loadImageConfig({
        IMAGE_MODE: 'direct',
        IMAGE_BASE_URL: 'https://api.ofox.ai/v1',
        IMAGE_API_KEY: 'k',
        IMAGE_MODEL: 'openai/gpt-image-2',
      }),
    ).toThrow(/不应带 \/v1 尾缀/);

    expect(
      loadImageConfig({
        IMAGE_MODE: 'direct',
        IMAGE_BASE_URL: 'https://api.ofox.ai',
        IMAGE_API_KEY: 'k',
        IMAGE_MODEL: 'openai/gpt-image-2',
      }).baseUrl,
    ).toBe('https://api.ofox.ai');
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

  it('超时上限的判据改成了「与任务预算的关系」，不再是固定的 20 秒', () => {
    /*
     * ## 这条断言原本冻结的是另一个行为
     *
     * 原文是「超时不得超过 20 秒（21.2 措施二不可被配置推翻）」，硬拒任何
     * 大于 20000 的取值。多模型故障转移引入后那个判据不再成立：T2 目标本身
     * 成了可以有意调整的量（110 → 155 秒），继续硬拒会挡住合法调整。
     *
     * 但原断言想守的东西**没有变**：一个配置项不该静默推翻 SLA。守法从
     * 「不许配大」换成了两条：
     *   - 越过任务预算 → 仍然硬拒（那会让故障转移静默失效，见下）
     *   - 只是越过素材窗口 → 允许，但必须留下 slaWarning
     *
     * 改判据而不是删测试：删掉的话，下一次有人把 timeoutMs 配成 600 秒时
     * 没有任何东西会拦他。
     */
    expect(loadImageConfig({ IMAGE_TIMEOUT_MS: '8000' }).timeoutMs).toBe(8_000);
    // 40 秒现在是默认值，不再触发任何拒绝
    expect(loadImageConfig({ IMAGE_TIMEOUT_MS: '40000' }).timeoutMs).toBe(40_000);
    // 但超过任务级 AI 预算仍然启动即失败
    expect(() => loadImageConfig({ IMAGE_TIMEOUT_MS: '90000' })).toThrow(LlmConfigError);
  });

  it('fake 模式未提供渲染函数时生成必然失败（降级链因此可测）', async () => {
    const client = createImageClient(loadImageConfig({}));
    await expect(client.generate(request)).rejects.toThrow(ImageUnavailableError);
  });
});

describe('超时分层与任务级 AI 预算', () => {
  const base = { IMAGE_MODE: 'fake' } as Record<string, string | undefined>;

  it('IMAGE_TIMEOUT_MS 默认 40 秒，且 60 秒现在合法', () => {
    /*
     * 原来这里硬拒 > 20000，理由是「不允许一个配置项静默推翻 SLA」。
     * 现在 SLA 本身成了可被有意调整的量（T2 110 → 155 秒），硬拒会挡住
     * 合法调整。保留的是「不静默」，放开的是「不允许」。
     */
    expect(loadImageConfig(base).timeoutMs).toBe(40_000);
    expect(loadImageConfig({ ...base, IMAGE_TIMEOUT_MS: '60000' }).timeoutMs).toBe(60_000);
  });

  it('预热路径有自己的超时，默认 60 秒且不受素材窗口约束', () => {
    /*
     * assets:preheat 不在 T2 的 SLA 窗口内，可以慢慢生 ——
     * 预热过的目的地本来就不需要主路径再生图。
     */
    expect(loadImageConfig(base).preheatTimeoutMs).toBe(60_000);
    expect(loadImageConfig({ ...base, IMAGE_PREHEAT_TIMEOUT_MS: '120000' }).preheatTimeoutMs).toBe(
      120_000,
    );
  });

  it('单候选超时超过任务级 AI 预算时启动即失败', () => {
    /*
     * 这条约束仍然硬拒：单个候选就能吃掉整个任务的 AI 预算，说明两个数字
     * 之间的关系配错了 —— 而它不是「更慢」而是「候选链根本轮不到第二个」。
     */
    expect(() =>
      loadImageConfig({ ...base, IMAGE_TIMEOUT_MS: '90000', IMAGE_JOB_AI_BUDGET_MS: '80000' }),
    ).toThrow(LlmConfigError);
  });

  it('任务级 AI 预算超过素材窗口时只 warn，不拒绝启动', () => {
    /*
     * 「允许但显式告知」：调高 T2 是合法运营决策，但必须留下痕迹。
     * 静默才是原来那条硬拒真正反对的东西。
     */
    const config = loadImageConfig({ ...base, IMAGE_JOB_AI_BUDGET_MS: '200000' });

    expect(config.jobAiBudgetMs).toBe(200_000);
    expect(config.slaWarning).toContain('素材窗口');
  });

  it('预算未越界时没有 slaWarning', () => {
    expect(loadImageConfig(base).slaWarning).toBeUndefined();
  });
});
