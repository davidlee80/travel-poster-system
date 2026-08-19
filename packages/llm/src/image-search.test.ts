import { describe, expect, it } from 'vitest';

import {
  FakeLicensedSourceClient,
  IMAGE_SEARCH_MODES,
  IMAGE_SEARCH_TIMEOUT_MS,
  ImageSearchTimeoutError,
  ImageSearchUnavailableError,
  createLicensedSourceClient,
  loadImageSearchConfig,
  searchWarningCode,
  type LicensedSourceCandidate,
  type LicensedSourceQuery,
} from './image-search.js';
import { LlmConfigError } from './config.js';

/**
 * 授权图源搜索客户端（TP-6-02，设计稿 9.6、21.4 的 R-45）。
 *
 * 这里断言的是**约束值与失败语义**，不是某个图源的 API 形状 ——
 * 本轮只交付 fake 与适配器接口（见 image-search.ts 的头部说明）。
 */

const query: LicensedSourceQuery = {
  text: '杭州 拱宸桥 运河 晨雾',
  aspectRatio: '16:9',
  minWidth: 1200,
  limit: 5,
};

function candidate(overrides: Partial<LicensedSourceCandidate> = {}): LicensedSourceCandidate {
  return {
    provider: 'fake-openverse',
    originalUrl: 'https://example.test/photos/1',
    downloadUrl: 'https://example.test/photos/1/full.jpg',
    licenseType: 'CC0',
    attributionText: '© 摄影者 / CC0',
    licenseExpiresAt: null,
    mimeType: 'image/jpeg',
    ...overrides,
  };
}

describe('IMAGE_SEARCH_MODE 配置（9.6）', () => {
  it('缺省为 fake', () => {
    expect(loadImageSearchConfig({}).mode).toBe('fake');
  });

  it('取值非法抛 LlmConfigError', () => {
    expect(() => loadImageSearchConfig({ IMAGE_SEARCH_MODE: 'gateway' })).toThrow(LlmConfigError);
  });

  it('只有 fake 与 direct 两种模式', () => {
    // 与 LLM/图片模型不同：搜索层没有「经网关」形态，网关不代理第三方图库
    expect(IMAGE_SEARCH_MODES).toEqual(['fake', 'direct']);
  });

  it('超时缺省为 9.6 的 5 秒', () => {
    expect(loadImageSearchConfig({}).timeoutMs).toBe(IMAGE_SEARCH_TIMEOUT_MS);
    expect(IMAGE_SEARCH_TIMEOUT_MS).toBe(5_000);
  });

  it('超时可下调', () => {
    expect(loadImageSearchConfig({ IMAGE_SEARCH_TIMEOUT_MS: '2000' }).timeoutMs).toBe(2_000);
  });

  it('超时不可上调到 5 秒以上', () => {
    /*
     * 与 IMAGE_TIMEOUT_MS 同一处理：9.6 的 5 秒是「搜索是冷路径，不占
     * 800 毫秒的库内预算」推出来的。允许配大等于允许一行配置静默推翻
     * 21.2 的时延预算，而违约会以「偶发 T2 超时」出现，无从关联到配置。
     */
    expect(() => loadImageSearchConfig({ IMAGE_SEARCH_TIMEOUT_MS: '8000' })).toThrow(
      LlmConfigError,
    );
  });

  it('超时非正整数被拒', () => {
    expect(() => loadImageSearchConfig({ IMAGE_SEARCH_TIMEOUT_MS: '0' })).toThrow(LlmConfigError);
    expect(() => loadImageSearchConfig({ IMAGE_SEARCH_TIMEOUT_MS: 'abc' })).toThrow(LlmConfigError);
  });

  it('图源白名单从配置读，逗号分隔并去空白', () => {
    const config = loadImageSearchConfig({
      IMAGE_SEARCH_PROVIDERS: 'openverse, wikimedia ,,openverse',
    });
    // 去重且去空项 —— 白名单重复项会让日预算被同一个图源算两次
    expect(config.providers).toEqual(['openverse', 'wikimedia']);
  });

  it('fake 模式白名单可为空', () => {
    expect(loadImageSearchConfig({}).providers).toEqual([]);
  });

  it('direct 模式启动即失败（本轮无图源适配器）', () => {
    /*
     * 这是 P6 的显式交付边界。做成运行时降级的话，「忘记接图源」会表现为
     * 「搜索层永远静默跳过」—— 那与 9.6 的全局熔断在指标图上完全一样，
     * 而两者该有的处置完全不同（一个是去接图源，一个是别再花钱）。
     */
    expect(() =>
      loadImageSearchConfig({
        IMAGE_SEARCH_MODE: 'direct',
        IMAGE_SEARCH_PROVIDERS: 'openverse',
      }),
    ).toThrow(/尚未接入任何授权图源适配器/);
  });

  it('日预算缺省与可配', () => {
    expect(loadImageSearchConfig({}).dailyBudget).toBe(2_000);
    expect(loadImageSearchConfig({ IMAGE_SEARCH_DAILY_BUDGET: '50' }).dailyBudget).toBe(50);
    expect(() => loadImageSearchConfig({ IMAGE_SEARCH_DAILY_BUDGET: '-1' })).toThrow(
      LlmConfigError,
    );
  });
});

describe('createLicensedSourceClient', () => {
  it('fake 模式且未提供候选源时，search 抛不可用（降级链因此可测）', async () => {
    const client = createLicensedSourceClient(loadImageSearchConfig({}));
    await expect(client.search(query, 5_000)).rejects.toBeInstanceOf(ImageSearchUnavailableError);
  });

  it('fake 模式带候选源时正常返回', async () => {
    const client = createLicensedSourceClient(loadImageSearchConfig({}), {
      candidates: [candidate()],
    });
    expect(await client.search(query, 5_000)).toHaveLength(1);
  });
});

describe('FakeLicensedSourceClient', () => {
  it('按脚本返回候选并记录查询', async () => {
    const client = new FakeLicensedSourceClient({ candidates: [candidate(), candidate()] });

    const results = await client.search(query, 5_000);

    expect(results).toHaveLength(2);
    expect(client.searchCalls).toEqual([query]);
  });

  it('limit 生效', async () => {
    const client = new FakeLicensedSourceClient({
      candidates: [candidate(), candidate(), candidate()],
    });
    expect(await client.search({ ...query, limit: 2 }, 5_000)).toHaveLength(2);
  });

  it('可编排为抛超时', async () => {
    const client = new FakeLicensedSourceClient({ behaviors: ['timeout'] });
    await expect(client.search(query, 5_000)).rejects.toBeInstanceOf(ImageSearchTimeoutError);
  });

  it('可编排为抛不可用', async () => {
    const client = new FakeLicensedSourceClient({ behaviors: ['unavailable'] });
    await expect(client.search(query, 5_000)).rejects.toBeInstanceOf(ImageSearchUnavailableError);
  });

  it('behaviors 按调用次序消耗，用尽后回到正常返回', async () => {
    const client = new FakeLicensedSourceClient({
      behaviors: ['timeout', 'unavailable'],
      candidates: [candidate()],
    });

    await expect(client.search(query, 5_000)).rejects.toBeInstanceOf(ImageSearchTimeoutError);
    await expect(client.search(query, 5_000)).rejects.toBeInstanceOf(ImageSearchUnavailableError);
    expect(await client.search(query, 5_000)).toHaveLength(1);
  });

  it('download 返回可配置的字节，并记录被下载的候选', async () => {
    const bytes = new Uint8Array([1, 2, 3]);
    const client = new FakeLicensedSourceClient({ candidates: [candidate()], bytes });

    const downloaded = await client.download(candidate(), 5_000);

    expect(downloaded).toEqual(bytes);
    expect(client.downloadCalls).toHaveLength(1);
  });

  it('download 可编排为失败', async () => {
    const client = new FakeLicensedSourceClient({ downloadBehaviors: ['unavailable'] });
    await expect(client.download(candidate(), 5_000)).rejects.toBeInstanceOf(
      ImageSearchUnavailableError,
    );
  });

  it('providers 暴露白名单', () => {
    const client = new FakeLicensedSourceClient({ providers: ['openverse'] });
    expect(client.providers).toEqual(['openverse']);
  });
});

describe('searchWarningCode（13.7 不新增错误码）', () => {
  it('任何失败都映射到 ASSET_LICENSED_SOURCE_UNAVAILABLE', () => {
    /*
     * 9.6 明确「13.7 不需要新错误码」。超时与不可用在**处置**上没有区别
     * （都是降入 AI 层且不重试），区分只会让 warnings 多一个取值而没有
     * 任何一方会按它分流。具体原因在日志与 travel_asset_search_total
     * 的 outcome 标签里。
     */
    expect(searchWarningCode(new ImageSearchTimeoutError('t'))).toBe(
      'ASSET_LICENSED_SOURCE_UNAVAILABLE',
    );
    expect(searchWarningCode(new ImageSearchUnavailableError('u'))).toBe(
      'ASSET_LICENSED_SOURCE_UNAVAILABLE',
    );
    expect(searchWarningCode(new Error('别的什么'))).toBe('ASSET_LICENSED_SOURCE_UNAVAILABLE');
  });
});
