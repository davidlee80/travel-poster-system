import { GracefulShutdown, createSilentLogger, type ServiceConfig } from '@tps/shared';
import { beforeEach, describe, expect, it } from 'vitest';
import { buildServer } from '../server.js';
import { INTERNAL_API_KEY_HEADER } from './internal-auth.js';

/**
 * 14.2 生成路线 SVG（TP-3-10 的端点部分）。
 */

const config: ServiceConfig = {
  serviceName: 'tps-api-test',
  port: 0,
  nodeEnv: 'test',
  logLevel: 'silent',
  shutdownTimeoutMs: 1_000,
};

const KEY = 'internal-key-for-test';

function server(options: { readonly withKey?: boolean } = {}) {
  return buildServer({
    config,
    logger: createSilentLogger(),
    shutdown: new GracefulShutdown({ logger: createSilentLogger(), timeoutMs: 1_000 }),
    ...(options.withKey === false ? {} : { internalAssets: { internalApiKey: KEY } }),
  });
}

const nodes = [
  { name: '拱宸桥', latitude: 30.3201, longitude: 120.1421 },
  { name: '大兜路', latitude: 30.3105, longitude: 120.1502 },
];

describe('POST /internal/v1/maps/render-schematic', () => {
  let app: ReturnType<typeof buildServer>;

  beforeEach(() => {
    app = server();
  });

  it('渲染成功返回 SVG 与内容寻址哈希', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/internal/v1/maps/render-schematic',
      headers: { [INTERNAL_API_KEY_HEADER]: KEY },
      payload: { style: 'CANAL_GREEN', nodes },
    });

    expect(response.statusCode).toBe(200);
    const body = response.json<{
      rendered: boolean;
      svg: string;
      node_count: number;
      route_node_hash: string;
      width: number;
      height: number;
    }>();

    expect(body.rendered).toBe(true);
    expect(body.svg).toContain('<svg');
    expect(body.node_count).toBe(2);
    expect(body.route_node_hash).toMatch(/^[0-9a-f]{16}$/);
    expect(body.width).toBe(1200);
    expect(body.height).toBe(800);
  });

  it('节点不足返回 200 + rendered: false（业务结果而不是错误）', async () => {
    /*
     * 用 4xx 的话，resolver 会把它当成失败去重试 —— 而重试的输入完全相同。
     * 节点不足是 V-08 剔除越界坐标后的正常结果，调用方据此走文字降级（8.2）。
     */
    const response = await app.inject({
      method: 'POST',
      url: '/internal/v1/maps/render-schematic',
      headers: { [INTERNAL_API_KEY_HEADER]: KEY },
      payload: { style: 'CANAL_GREEN', nodes: [nodes[0]] },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      rendered: false,
      reason: 'INSUFFICIENT_NODES',
      valid_nodes: 1,
    });
  });

  it('坐标非法的节点被剔除后仍能出图', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/internal/v1/maps/render-schematic',
      headers: { [INTERNAL_API_KEY_HEADER]: KEY },
      payload: {
        style: 'CANAL_GREEN',
        nodes: [...nodes, { name: '坏点', latitude: null, longitude: null }],
      },
    });

    expect(response.json<{ node_count: number }>().node_count).toBe(2);
  });

  it('缺密钥或密钥错误返回 404（不确认端点存在性）', async () => {
    const withoutKey = await app.inject({
      method: 'POST',
      url: '/internal/v1/maps/render-schematic',
      payload: { style: 'CANAL_GREEN', nodes },
    });
    expect(withoutKey.statusCode).toBe(404);

    const wrongKey = await app.inject({
      method: 'POST',
      url: '/internal/v1/maps/render-schematic',
      headers: { [INTERNAL_API_KEY_HEADER]: 'wrong-key-same-length' },
      payload: { style: 'CANAL_GREEN', nodes },
    });
    expect(wrongKey.statusCode).toBe(404);
  });

  it('未配置密钥时路由不存在', async () => {
    const bare = server({ withKey: false });
    const response = await bare.inject({
      method: 'POST',
      url: '/internal/v1/maps/render-schematic',
      payload: { style: 'CANAL_GREEN', nodes },
    });
    expect(response.statusCode).toBe(404);
    await bare.close();
  });

  it.each([
    ['未知风格', { style: 'RAINBOW', nodes }],
    ['节点缺名称', { style: 'CANAL_GREEN', nodes: [{ latitude: 30, longitude: 120 }] }],
    ['节点超上限', { style: 'CANAL_GREEN', nodes: Array.from({ length: 31 }, () => nodes[0]) }],
    ['缺 nodes', { style: 'CANAL_GREEN' }],
  ])('%s 返回 400', async (_label, payload) => {
    const response = await app.inject({
      method: 'POST',
      url: '/internal/v1/maps/render-schematic',
      headers: { [INTERNAL_API_KEY_HEADER]: KEY },
      payload,
    });
    expect(response.statusCode).toBe(400);
  });
});
