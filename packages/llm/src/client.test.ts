import { describe, expect, it } from 'vitest';

import {
  DirectLlmClient,
  FakeLlmClient,
  GatewayLlmClient,
  LlmOutputUnparseableError,
  LlmTimeoutError,
  LlmUnavailableError,
  llmErrorCode,
  type LlmRequest,
} from './client.js';
import { LLM_MODES, LlmConfigError, createLlmClient, loadLlmConfig } from './config.js';

/**
 * 模型访问层（TP-2-10）。
 *
 * 断言集中在三处**只有实现层才能保证**的行为：
 *   1. 结构化输出真的用了 `response_format`（6.3），不是靠提示词请求 JSON；
 *   2. 三类错误各自映射到 13.7 的不同码；
 *   3. 配置切换不改业务代码 —— 调用方拿到的始终是 `LlmClient`。
 */

const request: LlmRequest = {
  system: '你是行程规划师',
  user: '杭州 5 天',
  jsonSchema: { name: 'travel_plan', schema: { type: 'object' } },
  maxTokens: 16_384,
  purpose: 'plan',
  timeoutMs: 30_000,
};

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function completion(content: unknown, extra: Record<string, unknown> = {}): unknown {
  return {
    model: 'test-model',
    choices: [{ message: { content: JSON.stringify(content) }, finish_reason: 'stop', ...extra }],
    usage: { prompt_tokens: 100, completion_tokens: 2_000 },
  };
}

describe('FakeLlmClient', () => {
  it('按顺序回放，用完后重复最后一个', async () => {
    // 3.2.2 的定向重生成会多次调用；耗尽后抛错会让「测第 3 次调用」变得很别扭
    const client = new FakeLlmClient([{ n: 1 }, { n: 2 }]);
    expect((await client.complete(request)).data).toEqual({ n: 1 });
    expect((await client.complete(request)).data).toEqual({ n: 2 });
    expect((await client.complete(request)).data).toEqual({ n: 2 });
  });

  it('记录每次请求，便于断言提示内容', async () => {
    const client = new FakeLlmClient([{}]);
    await client.complete(request);
    expect(client.calls).toHaveLength(1);
    expect(client.calls[0]!.user).toBe('杭州 5 天');
  });

  it('预置 Error 时抛出，用于测失败路径', async () => {
    const client = new FakeLlmClient([new LlmUnavailableError('演练')]);
    await expect(client.complete(request)).rejects.toBeInstanceOf(LlmUnavailableError);
  });

  it('token 计数为 0，不污染成本指标', async () => {
    // 编一个假数会让 travel_llm_tokens_total 在开发与生产之间无法区分
    const client = new FakeLlmClient([{}]);
    expect((await client.complete(request)).usage).toEqual({ inputTokens: 0, outputTokens: 0 });
  });

  it('没有预置输出时构造即失败', () => {
    expect(() => new FakeLlmClient([])).toThrow(/至少需要一个/);
  });
});

describe('HTTP 请求形状（6.3）', () => {
  it('用 json_schema 结构化输出，而不是靠提示词要求 JSON', async () => {
    /*
     * 6.3：「通过结构化输出（JSON Schema 约束模式）获取，不解析 Markdown
     * 代码块」。靠提示词在长输出下必然偶发失败，而那种失败以
     * 「第 9 天之后是一段散文」的形式出现 —— schema 校验只会报「字段缺失」。
     */
    let captured: { url: string; body: string } | null = null;
    const client = new DirectLlmClient({
      baseUrl: 'https://api.example.com/',
      apiKey: 'sk-test',
      model: 'test-model',
      fetchImpl: (url, init) => {
        /*
         * `fetch` 的第一个参数可以是 string / URL / Request，body 可以是
         * 多种类型。这里逐类型收窄而不是 `String(...)` —— 后者在类型变化时
         * 会静默产出 `[object Object]`，而断言仍然「通过」。
         */
        const href = typeof url === 'string' ? url : url instanceof URL ? url.href : url.url;
        const body = typeof init?.body === 'string' ? init.body : '';
        captured = { url: href, body };
        return Promise.resolve(jsonResponse(completion({ title: '杭州五日游' })));
      },
    });

    await client.complete(request);

    expect(captured).not.toBeNull();
    // 末尾斜杠被去掉，不会拼出 //v1
    expect(captured!.url).toBe('https://api.example.com/v1/chat/completions');

    const body = JSON.parse(captured!.body) as Record<string, unknown>;
    expect(body['max_tokens']).toBe(16_384);
    expect(body['response_format']).toEqual({
      type: 'json_schema',
      json_schema: { name: 'travel_plan', schema: { type: 'object' }, strict: true },
    });
  });

  it('解析出 JSON 对象与用量', async () => {
    const client = new DirectLlmClient({
      baseUrl: 'https://api.example.com',
      apiKey: 'sk-test',
      model: 'test-model',
      fetchImpl: () => Promise.resolve(jsonResponse(completion({ title: '杭州五日游' }))),
    });

    const result = await client.complete(request);
    expect(result.data).toEqual({ title: '杭州五日游' });
    expect(result.usage).toEqual({ inputTokens: 100, outputTokens: 2_000 });
    expect(result.model).toBe('test-model');
  });

  it('Direct 与 Gateway 的差别只有请求头', async () => {
    const headers: Record<string, string>[] = [];
    const fetchImpl: typeof fetch = (_url, init) => {
      headers.push((init?.headers ?? {}) as Record<string, string>);
      return Promise.resolve(jsonResponse(completion({})));
    };
    const options = { baseUrl: 'https://x.example.com', apiKey: 'sk-test', model: 'm', fetchImpl };

    await new DirectLlmClient(options).complete(request);
    await new GatewayLlmClient(options).complete(request);

    expect(headers[0]).toMatchObject({ authorization: 'Bearer sk-test' });
    expect(headers[0]?.['x-tps-service']).toBeUndefined();
    // 网关按调用方归集成本，不带这个头会让所有调用在网关报表里混成一团
    expect(headers[1]).toMatchObject({
      authorization: 'Bearer sk-test',
      'x-tps-service': 'travel-poster-system',
    });
  });
});

describe('错误分类（13.7）', () => {
  function clientWith(fetchImpl: typeof fetch): DirectLlmClient {
    return new DirectLlmClient({
      baseUrl: 'https://api.example.com',
      apiKey: 'sk-test',
      model: 'm',
      fetchImpl,
    });
  }

  it('非 2xx → 不可用，且不回显响应体', async () => {
    /*
     * 上游的错误体可能回显我们发过去的提示（含用户自由文本）。
     * 二十章禁止 raw_request 全文落日志，把它拼进错误消息同样违反。
     */
    const client = clientWith(() =>
      Promise.resolve(jsonResponse({ error: { message: '用户补充说明：我叫张三' } }, 500)),
    );

    const error = await client.complete(request).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(LlmUnavailableError);
    expect((error as Error).message).toContain('HTTP 500');
    expect((error as Error).message).not.toContain('张三');
  });

  it('超时 → LlmTimeoutError', async () => {
    const client = clientWith(() => {
      const error = new Error('timed out');
      error.name = 'TimeoutError';
      return Promise.reject(error);
    });
    await expect(client.complete(request)).rejects.toBeInstanceOf(LlmTimeoutError);
  });

  it('网络异常 → 不可用', async () => {
    const client = clientWith(() => Promise.reject(new TypeError('fetch failed')));
    await expect(client.complete(request)).rejects.toBeInstanceOf(LlmUnavailableError);
  });

  it('content 不是合法 JSON → 输出不可解析', async () => {
    const client = clientWith(() =>
      Promise.resolve(
        jsonResponse({
          choices: [{ message: { content: '这是一段散文' }, finish_reason: 'stop' }],
        }),
      ),
    );
    await expect(client.complete(request)).rejects.toBeInstanceOf(LlmOutputUnparseableError);
  });

  it('缺 content → 输出不可解析', async () => {
    const client = clientWith(() => Promise.resolve(jsonResponse({ choices: [{}] })));
    await expect(client.complete(request)).rejects.toBeInstanceOf(LlmOutputUnparseableError);
  });

  it('被 max_tokens 截断时的错误消息指向分档', async () => {
    /*
     * 截断的输出是语法不完整的 JSON，解析必然失败。先看 finish_reason
     * 才能给出正确原因 —— 否则排查方向会从「6.3 的 max_tokens 分档不够」
     * 错误地转向「模型不听指令」。
     */
    const client = clientWith(() =>
      Promise.resolve(
        jsonResponse({
          choices: [{ message: { content: '{"days":[' }, finish_reason: 'length' }],
        }),
      ),
    );

    const error = await client.complete(request).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(LlmOutputUnparseableError);
    expect((error as Error).message).toContain('16384 token');
  });

  it('三类错误映射到三个不同的码', () => {
    expect(llmErrorCode(new LlmTimeoutError(30_000))).toBe('PLAN_LLM_TIMEOUT');
    expect(llmErrorCode(new LlmOutputUnparseableError('x'))).toBe('PLAN_LLM_OUTPUT_UNPARSEABLE');
    expect(llmErrorCode(new LlmUnavailableError('x'))).toBe('PLAN_LLM_UNAVAILABLE');
  });

  it('未知异常按可重试的不可用处理', () => {
    // 标成「输出不可解析」会让运维去查提示词，而问题其实在网络上
    expect(llmErrorCode(new Error('???'))).toBe('PLAN_LLM_UNAVAILABLE');
  });
});

describe('配置切换（1.3）', () => {
  it('三种模式各自产出对应实现，调用方代码不变', () => {
    const fetchImpl: typeof fetch = () => Promise.resolve(jsonResponse(completion({})));

    const fake = createLlmClient(
      { mode: 'fake', model: '', baseUrl: '', apiKey: '', timeoutMs: 1 },
      { fixtures: [{}] },
    );
    const direct = createLlmClient(
      {
        mode: 'direct',
        model: 'm',
        baseUrl: 'https://a',
        apiKey: 'k',
        timeoutMs: 1,
      },
      { fetchImpl },
    );
    const gateway = createLlmClient(
      {
        mode: 'gateway',
        model: 'm',
        baseUrl: 'https://g',
        apiKey: 'k',
        timeoutMs: 1,
      },
      { fetchImpl },
    );

    expect(fake).toBeInstanceOf(FakeLlmClient);
    expect(direct).toBeInstanceOf(DirectLlmClient);
    expect(gateway).toBeInstanceOf(GatewayLlmClient);
    // 三者共享同一个接口形状
    for (const client of [fake, direct, gateway]) {
      expect(typeof client.complete).toBe('function');
      expect(typeof client.model).toBe('string');
    }
  });

  it('缺省为 fake', () => {
    expect(loadLlmConfig({}).mode).toBe('fake');
  });

  it('模式取值非法时启动即失败', () => {
    expect(() => loadLlmConfig({ LLM_MODE: 'openai' })).toThrow(LlmConfigError);
  });

  it('direct / gateway 缺配置时抛错，不回退到 fake', () => {
    /*
     * 回退的表现是「上线后用户拿到的全是同一份录制计划」，
     * 而系统看起来完全正常 —— 没有报错、没有告警、响应还特别快。
     */
    expect(() => loadLlmConfig({ LLM_MODE: 'direct' })).toThrow(/LLM_BASE_URL 必填/);
    expect(() =>
      loadLlmConfig({ LLM_MODE: 'gateway', LLM_GATEWAY_URL: 'https://g', LLM_MODEL: 'm' }),
    ).toThrow(/LLM_API_KEY 必填/);
  });

  it('gateway 模式读 LLM_GATEWAY_URL，direct 模式读 LLM_BASE_URL', () => {
    // 两个变量分开是有意的：切换模式时不必改同一个变量的值，
    // 也就不会出现「切回 direct 时忘了把网关地址换回来」
    const gateway = loadLlmConfig({
      LLM_MODE: 'gateway',
      LLM_GATEWAY_URL: 'https://gateway.internal',
      LLM_API_KEY: 'k',
      LLM_MODEL: 'm',
    });
    expect(gateway.baseUrl).toBe('https://gateway.internal');
  });

  it('超时缺省 30 秒（3.2.2）', () => {
    expect(loadLlmConfig({}).timeoutMs).toBe(30_000);
    expect(() => loadLlmConfig({ LLM_TIMEOUT_MS: '0' })).toThrow(LlmConfigError);
  });

  it('fake 模式未提供录制输出时，调用会明确报错', async () => {
    // 静默返回空对象会让「忘了准备 fixture」表现为一堆 schema 校验失败
    const client = createLlmClient({
      mode: 'fake',
      model: '',
      baseUrl: '',
      apiKey: '',
      timeoutMs: 1,
    });
    await expect(client.complete(request)).rejects.toThrow(/没有提供录制输出/);
  });

  it('模式清单与实现一一对应', () => {
    expect([...LLM_MODES]).toEqual(['fake', 'direct', 'gateway']);
  });
});

describe('ofox 接入', () => {
  it('ofox 的 base 拼出 /v1/chat/completions，不需要任何专属代码', async () => {
    /*
     * ofox 的 OpenAI 兼容协议与上面的请求体完全一致，所以「接入」只是配置。
     * 这条断言把那个前提钉住：base 填 https://api.ofox.ai 时打到的地址
     * 必须正好是 ofox 的端点。
     */
    let href = '';
    const client = new DirectLlmClient({
      baseUrl: 'https://api.ofox.ai',
      apiKey: 'sk-of-test',
      model: 'openai/gpt-5.5',
      fetchImpl: (url) => {
        href = typeof url === 'string' ? url : url instanceof URL ? url.href : url.url;
        return Promise.resolve(jsonResponse(completion({})));
      },
    });

    await client.complete(request);
    expect(href).toBe('https://api.ofox.ai/v1/chat/completions');
  });

  it('base 带 /v1 尾缀时启动即失败，而不是运行时 404', () => {
    /*
     * ofox 文档给的是 SDK 写法（baseURL: https://api.ofox.ai/v1，SDK 自己拼
     * 后半段）。照抄进 env 会打到 /v1/v1/chat/completions —— 那个 404 会被
     * 归类为「上游不可用」并进入重试，日志里只有一行 HTTP 404，
     * 而配置看起来完全正常。所以这里必须在启动时就拦住。
     */
    expect(() =>
      loadLlmConfig({
        LLM_MODE: 'direct',
        LLM_BASE_URL: 'https://api.ofox.ai/v1',
        LLM_API_KEY: 'k',
        LLM_MODEL: 'openai/gpt-5.5',
      }),
    ).toThrow(/不应带 \/v1 尾缀/);

    // 尾随斜杠不该让检查失效 —— 它在客户端里本来就会被去掉
    expect(() =>
      loadLlmConfig({
        LLM_MODE: 'direct',
        LLM_BASE_URL: 'https://api.ofox.ai/v1/',
        LLM_API_KEY: 'k',
        LLM_MODEL: 'openai/gpt-5.5',
      }),
    ).toThrow(LlmConfigError);

    // gateway 走同一条规则：拼路径的是客户端，与走哪个端点无关
    expect(() =>
      loadLlmConfig({
        LLM_MODE: 'gateway',
        LLM_GATEWAY_URL: 'https://gw.internal/openai/v1',
        LLM_API_KEY: 'k',
        LLM_MODEL: 'm',
      }),
    ).toThrow(/LLM_GATEWAY_URL/);
  });

  it('不带版本号的 base 正常通过', () => {
    const config = loadLlmConfig({
      LLM_MODE: 'direct',
      LLM_BASE_URL: 'https://api.ofox.ai',
      LLM_API_KEY: 'sk-of-test',
      LLM_MODEL: 'openai/gpt-5.5',
    });
    expect(config.baseUrl).toBe('https://api.ofox.ai');
    // provider 前缀是 ofox 的要求，但**不做格式校验**（见 DirectLlmClient 注释）
    expect(config.model).toBe('openai/gpt-5.5');
  });
});
