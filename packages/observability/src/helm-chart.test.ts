import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';

/**
 * Helm chart 的不变量自检（TP-5-09，设计稿 22.3）。
 *
 * ## 为什么这些断言值得写
 *
 * 22.3.1 与 22.3.2 列的约束里有几条**违反后不会报错**：
 *
 * ```text
 * runAsUser 漏了某个服务   那个 Pod 以 root 跑，一切正常，直到有人利用它
 * /dev/shm 挂载丢了        Chromium 崩，报 "Target closed" —— 与内存不足
 *                          的症状一样，排查时会先去查 resources
 * 宽限期小于停机预算       滚动更新时任务被 SIGKILL 打断，留下悬挂状态；
 *                          而那要等用户报「页面一直转圈」才会被发现
 * retention 多副本         同一批到期用户被并发清理
 * ```
 *
 * ## 为什么是文本层断言而不是渲染后断言
 *
 * `helm template` 需要 helm 二进制，而本机没有（chart 的语法与渲染由 CI 的
 * `helm lint` + `helm template` 验证）。这里读的是 values.yaml（纯 YAML，
 * 可解析）与模板源码（按文本查关键字段）。
 *
 * 文本层断言拦不住「模板语法写错」，但那一类 CI 会拦。它拦的是**值被改掉**
 * 与**约束被删掉** —— 而那两类恰好是 CI 的 lint 拦不住的。
 */

const CHART_DIR = join(
  dirname(fileURLToPath(import.meta.url)),
  '../../../deploy/helm/travel-poster',
);

function readChartFile(relative: string): string {
  return readFileSync(join(CHART_DIR, relative), 'utf8');
}

interface Resources {
  readonly requests: { readonly cpu: string; readonly memory: string };
  readonly limits: { readonly cpu: string; readonly memory: string };
}

interface Values {
  readonly services: Record<
    string,
    {
      readonly replicas: number;
      readonly resources: Resources;
      readonly probePort?: number;
      readonly devShmSizeLimit?: string;
      readonly service?: { readonly enabled: boolean; readonly port: number };
    }
  >;
  readonly terminationGracePeriodSeconds: number;
  readonly podSecurityContext: Record<string, unknown>;
  readonly containerSecurityContext: Record<string, unknown>;
  readonly featureFlags: Record<string, unknown>;
  readonly existingSecret: string;
  readonly global: { readonly env: Record<string, string> };
}

const values: Values = parse(readChartFile('values.yaml'));
const deployment = readChartFile('templates/deployment.yaml');

/** `2Gi` → 字节数。只支持本 chart 用到的单位 */
function toBytes(quantity: string): number {
  const match = /^(\d+)(Mi|Gi)$/.exec(quantity);
  if (match === null) throw new Error(`无法解析内存量：${quantity}`);
  return Number(match[1]) * (match[2] === 'Gi' ? 1024 ** 3 : 1024 ** 2);
}

describe('Helm chart：五个服务', () => {
  it('五个服务都在 values 里', () => {
    expect(Object.keys(values.services).sort()).toEqual([
      'api',
      'generationWorker',
      'renderWorker',
      'retentionWorker',
      'web',
    ]);
  });

  it('每个服务都有资源 requests 与 limits', () => {
    /*
     * 没有 requests 的 Pod 会被调度到任意节点上（K8s 认为它不占资源），
     * 而没有 limits 的容器能吃掉整个节点的内存 —— render-worker 尤其危险，
     * Chromium 的内存占用与页面内容成正比。
     */
    for (const [name, service] of Object.entries(values.services)) {
      expect(service.resources.requests.cpu, `${name} 缺 requests.cpu`).toBeTruthy();
      expect(service.resources.requests.memory, `${name} 缺 requests.memory`).toBeTruthy();
      expect(service.resources.limits.cpu, `${name} 缺 limits.cpu`).toBeTruthy();
      expect(service.resources.limits.memory, `${name} 缺 limits.memory`).toBeTruthy();
      expect(
        toBytes(service.resources.limits.memory),
        `${name} 的 limit 不应小于 request`,
      ).toBeGreaterThanOrEqual(toBytes(service.resources.requests.memory));
    }
  });

  it('渲染 Worker 内存 ≥ 2Gi（22.3.2）', () => {
    /*
     * 一个 browser + 3 个 page 的实测占用（21.2）。低于 2Gi 时 Chromium 会被
     * OOMKilled，而症状是 "Target closed" —— 与 /dev/shm 不足的表现一样，
     * 于是排查会先花在共享内存上。
     */
    expect(toBytes(values.services.renderWorker!.resources.requests.memory)).toBeGreaterThanOrEqual(
      2 * 1024 ** 3,
    );
  });

  it('渲染 Worker 的 /dev/shm 为 1Gi 且走内存（22.3.2）', () => {
    expect(values.services.renderWorker!.devShmSizeLimit).toBe('1Gi');
    // emptyDir: Memory 才是 tmpfs；默认的 emptyDir 落在节点磁盘上，不解决问题
    expect(deployment).toContain('medium: Memory');
    expect(deployment).toContain('mountPath: /dev/shm');
  });

  it('/dev/shm 占的是 Pod 内存配额，因此 limit 必须留出余量', () => {
    /*
     * `medium: Memory` 的 emptyDir 计入容器的内存 limit。1Gi 的 tmpfs 加上
     * Chromium 自己的 2Gi，limit 给 2Gi 就会在页面稍复杂时被 OOMKilled ——
     * 而那看起来像「渲染偶发失败」。
     */
    const render = values.services.renderWorker!;
    expect(toBytes(render.resources.limits.memory)).toBeGreaterThanOrEqual(
      toBytes(render.resources.requests.memory) + toBytes(render.devShmSizeLimit!),
    );
  });

  it('只有 web 与 api 暴露 Service', () => {
    const exposed = Object.entries(values.services)
      .filter(([, service]) => service.service?.enabled === true)
      .map(([name]) => name)
      .sort();
    expect(exposed).toEqual(['api', 'web']);
  });

  it('三个 Worker 各有独立的探针端口', () => {
    const ports = Object.entries(values.services)
      .filter(([, service]) => service.probePort !== undefined)
      .map(([, service]) => service.probePort!);
    expect(ports).toHaveLength(3);
    expect(new Set(ports).size).toBe(3);
  });

  it('保留期清理 Worker 必须单副本，且用 Recreate 策略', () => {
    /*
     * 清理任务在进程内按固定间隔跑（见 apps/retention-worker/src/main.ts）。
     * 多副本会让同一批到期用户被并发清理；而 RollingUpdate 在新 Pod 就绪前
     * 保留旧 Pod —— 那一瞬间就是两个实例。
     */
    expect(values.services.retentionWorker!.replicas).toBe(1);
    expect(deployment).toContain('type: Recreate');
  });
});

describe('Helm chart：安全上下文（22.3.1）', () => {
  it('以数值型非 root UID/GID 运行', () => {
    // 用名字（node）在某些 K8s 的 runAsUser 校验下不生效
    expect(values.podSecurityContext['runAsUser']).toBe(10001);
    expect(values.podSecurityContext['runAsGroup']).toBe(10001);
    expect(values.podSecurityContext['runAsNonRoot']).toBe(true);
  });

  it('禁止提权并丢弃全部 capability', () => {
    expect(values.containerSecurityContext['allowPrivilegeEscalation']).toBe(false);
    expect(values.containerSecurityContext['capabilities']).toEqual({ drop: ['ALL'] });
  });

  it('安全上下文对全部服务统一生效（不是逐服务配置）', () => {
    /*
     * 模板用同一个 `.Values.podSecurityContext` 渲染所有五个 Deployment。
     * 改成逐服务配置的话，漏掉一个的表现是那个 Pod 以 root 跑 ——
     * 而没有任何东西会报错。这条断言钉住「统一」这个结构。
     */
    expect(deployment).toContain('toYaml $.Values.podSecurityContext');
    expect(deployment).toContain('toYaml $.Values.containerSecurityContext');
    for (const service of Object.values(values.services)) {
      expect(service).not.toHaveProperty('podSecurityContext');
    }
  });

  it('不挂载 Kubernetes API token', () => {
    // 五个服务都不调用 K8s API。默认挂载等于给每个 Pod 一份可用的集群凭据
    expect(readChartFile('templates/serviceaccount.yaml')).toContain(
      'automountServiceAccountToken: false',
    );
  });
});

describe('Helm chart：停机与探针（22.3.3）', () => {
  it('宽限期大于应用侧的停机预算', () => {
    /*
     * GracefulShutdown 默认 25 秒、L-10 的验收线是 30 秒。宽限期小于它会让
     * 收尾被 SIGKILL 打断，任务留下悬挂状态 —— 而那要等用户报
     * 「页面一直转圈」才会被发现。
     */
    expect(values.terminationGracePeriodSeconds).toBeGreaterThan(30);
  });

  it('存活探针查 /healthz、就绪探针查 /readyz', () => {
    // 两者路径不同是刻意的：排空期间 /healthz 仍返回 200，
    // 否则 K8s 会在优雅停机中途 SIGKILL 掉本实例
    expect(deployment).toContain('path: /healthz');
    expect(deployment).toContain('path: /readyz');
  });

  it('就绪探针失败一次即摘除', () => {
    // 容忍多次会让 LB 在十几秒内继续往一个正在关闭的实例转发请求
    const readiness = deployment.slice(deployment.indexOf('readinessProbe:'));
    expect(readiness).toContain('failureThreshold: 1');
  });
});

describe('Helm chart：配置与密钥的分野', () => {
  it('values 里没有任何密钥', () => {
    /*
     * values 会进 Git、进 CI 日志、进 `helm get values` 的输出 ——
     * 而后者对任何有集群读权限的人可见。
     */
    const text = readChartFile('values.yaml');
    for (const forbidden of [
      'DATABASE_URL:',
      'REDIS_URL:',
      'S3_ACCESS_KEY_ID:',
      'S3_SECRET_ACCESS_KEY:',
      'LLM_API_KEY:',
      'IMAGE_API_KEY:',
      'SESSION_SIGNING_KEY:',
      'INTERNAL_API_KEY:',
      'RENDER_SIGNING_KEY:',
    ]) {
      expect(text.includes(forbidden), `values.yaml 不应含 ${forbidden}`).toBe(false);
    }
    expect(values.existingSecret).toBeTruthy();
  });

  it('IP 日配额 ≥ 2 × 匿名日配额（21.4 的耦合不变式）', () => {
    /*
     * 21.4 明确这两个数值存在耦合：IP 上限低于两倍时，IP 维度会先撞墙，
     * 账号维度的配额就成了摆设，而受影响的是 NAT 后的正常用户。
     * 应用启动时也校验这一条（fail fast），这里在部署配置层再拦一次 ——
     * 前者能防住上线，后者能防住 review。
     */
    const env = values.global.env;
    expect(Number(env['QUOTA_IP_PLANS_PER_DAY'])).toBeGreaterThanOrEqual(
      2 * Number(env['QUOTA_ANON_DAILY_PLANS']),
    );
  });

  it('匿名 AI Hero 额度为 0（21.4 的成本设计）', () => {
    expect(values.global.env['QUOTA_ANON_AI_HERO']).toBe('0');
  });

  it('配置变更会触发滚动更新', () => {
    /*
     * 不加 checksum 注解的话，改完 ConfigMap 后 `helm upgrade` 什么都不做 ——
     * Pod 还在用旧配置，而 helm 显示「已更新」。
     */
    expect(deployment).toContain('checksum/config:');
  });

  it('灰度开关注入全部服务（TP-5-10）', () => {
    expect(values.featureFlags).toHaveProperty('generationEnabled');
    expect(values.featureFlags).toHaveProperty('exportEnabled');
    expect(values.featureFlags).toHaveProperty('generationRolloutPercent');
    expect(deployment).toContain('FEATURE_GENERATION_ENABLED');
    expect(deployment).toContain('FEATURE_EXPORT_ENABLED');
    expect(deployment).toContain('FEATURE_GENERATION_ROLLOUT_PERCENT');
  });
});
