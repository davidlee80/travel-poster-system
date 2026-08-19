/**
 * 24.1 的 38 项验收门禁清单（TP-5-06；#35～#38 随 P6 的 TP-6-17 纳入）。
 *
 * ## 为什么需要这份清单
 *
 * 设计稿 24.1 用四张表列出 38 项，每项给了「验证方式」与「通过线」。
 * 但那是**文字描述**：「端到端自动化用例」「越权测试」「逐字段断言」。
 * 要回答「现在是 38/38 吗」，得有人把 38 项逐个对着代码找一遍 ——
 * 而那件事没人会每周做，于是「34/34 通过」永远停留在「应该是吧」。
 *
 * 这份清单把每项映射到一条**可执行的命令**，并对确实不能自动化的项
 * 如实标注原因。它回答的问题是「哪些项现在真的绿、哪些项还没有执行者」。
 *
 * ## 三种状态，含义各不相同
 *
 * ```text
 * command   有命令可跑，跑通即通过
 * ci-only   只能在 Linux 容器里验证（字体、Chromium、/dev/shm、镜像）
 *           —— 本机跑不算通过（实施计划 3.1 原则四）
 * manual    需要真实模型、真实流量或人工确认，V1 内测前由人执行一次
 * ```
 *
 * `manual` 不是「做不到」的借口，而是**边界的声明**：把一项需要真实图片模型
 * 的命中率统计伪装成自动测试，只会让门禁报告说谎。
 *
 * ## 一处需要注意的「通过」
 *
 * #34（优雅停机）在本机报「通过」，但那条测试在 Windows / macOS 上是
 * **跳过**的 —— vitest 对跳过的文件退出码为 0。真正执行它的是 CI 的
 * shutdown job。这个不对称没法在这里消除（工具无法判断一个命令内部是否
 * 跳过了测试），因此写在这里与那一项的 `why` 里。
 */

/**
 * @typedef {Object} Gate
 * @property {number} id            24.1 的编号
 * @property {string} title
 * @property {string} ref           设计稿依据
 * @property {'command'|'ci-only'|'manual'} kind
 * @property {string} [run]         kind=command 时的命令
 * @property {string} [why]         kind≠command 时的理由；或命令的补充说明
 * @property {boolean} [needsDb]    需要 DATABASE_URL + REDIS_URL
 */

/** @type {readonly Gate[]} */
export const GATES = [
  // ── 24.1 的原 15 项 ──────────────────────────────────────
  {
    id: 1,
    title: '端到端自动化用例（20 个，覆盖 1/3/7/14 天与多种约束组合）',
    ref: '24.1 #1',
    kind: 'command',
    run: 'pnpm test:acceptance',
    needsDb: true,
  },
  {
    id: 2,
    title: 'travel_plan_versions 存在对应行且 plan_json 可被 Zod 解析',
    ref: '24.1 #2',
    kind: 'command',
    run: 'pnpm test:acceptance',
    why: '20 个用例各自断言 TravelPlanSchema.safeParse 成功',
    needsDb: true,
  },
  {
    id: 3,
    title: 'COMPLETED 任务的 constraint_report 无 BLOCKING',
    ref: '24.1 #3',
    kind: 'command',
    run: 'pnpm test:acceptance',
    needsDb: true,
  },
  {
    id: 4,
    title: 'plan_presentations 行数 = total_days + 1',
    ref: '24.1 #4',
    kind: 'command',
    run: 'pnpm test:acceptance',
    needsDb: true,
  },
  {
    id: 5,
    title: '图标加载成功率 100%（19 个键穷尽映射 + 指标恒为 0）',
    ref: '24.1 #5',
    kind: 'command',
    run: 'pnpm --filter @tps/icon-library run test && pnpm --filter @tps/render-worker exec vitest run metrics-catalog',
    why: '穷尽映射由 icon-library 单测保证；运行期由渲染侧的 [data-icon-missing] 计数（travel_icon_load_failure_total）与 21.3 的图标回归告警保证',
  },
  {
    id: 6,
    title: '故障注入：SVG 渲染器抛错 → text_fallback 存在，任务仍 COMPLETED',
    ref: '24.1 #6',
    kind: 'command',
    run: 'pnpm --filter @tps/assets exec vitest run svg-map && pnpm --filter @tps/generation-worker exec vitest run resolve-assets',
  },
  {
    id: 7,
    title: '故障注入：AI 图片服务全部超时 → Hero 为渐变背景，任务仍 COMPLETED',
    ref: '24.1 #7',
    kind: 'command',
    run: 'pnpm --filter @tps/generation-worker exec vitest run ai-generator resolve-assets',
  },
  {
    id: 8,
    title: '故障注入：素材库置空 + AI 关闭 → 使用占位图，任务仍 COMPLETED',
    ref: '24.1 #8',
    kind: 'command',
    run: 'pnpm --filter @tps/generation-worker exec vitest run resolve-assets',
    why: '端到端侧也覆盖：20 个验收用例跑在空素材库上，warnings 含 ASSET_LIBRARY_MISS 而任务仍 COMPLETED',
  },
  {
    id: 9,
    title: '17.3 溢出检测 + 视觉回归（像素差异 < 0.5%）',
    ref: '24.1 #9',
    kind: 'ci-only',
    why: '字体渲染在 Windows 与 Linux 上必然有差异，基线必须在容器内生成（22.3.4 L-08、门禁 #33）。CI 的 render job 执行 pnpm visual:check',
  },
  {
    id: 10,
    title: '每个 COMPLETED 计划至少有 HTML + 1 种导出产物可访问',
    ref: '24.1 #10',
    kind: 'command',
    run: 'pnpm --filter @tps/api exec vitest run exports && pnpm --filter @tps/db exec vitest run exports.integration --no-file-parallelism',
    why: '13.5/13.6 两个端点与 exports 仓储已覆盖；「真的渲染出 PDF 并上传」需要 Chromium + web + MinIO 三者同时在位，见 P4 的交付边界',
    needsDb: true,
  },
  {
    id: 11,
    title: '越权测试：A 用全部端点访问 B 的资源，全部 404',
    ref: '24.1 #11',
    kind: 'command',
    run: 'pnpm --filter @tps/api exec vitest run travel-plans exports auth',
  },
  {
    id: 12,
    title: '素材来源可追溯（source_type / license_type / representation_type 非空）',
    ref: '24.1 #12',
    kind: 'command',
    run: 'pnpm test:acceptance',
    needsDb: true,
  },
  {
    id: 13,
    title: '并发提交同一 client_request_id × 10 → 只产生 1 个 plan_id',
    ref: '24.1 #13',
    kind: 'command',
    run: 'pnpm test:idempotency',
    needsDb: true,
  },
  {
    id: 14,
    title: 'FAILED 任务的 error_code 在 13.7 表内，retryable 语义正确',
    ref: '24.1 #14',
    kind: 'command',
    run: 'pnpm test:state-machine',
  },
  {
    id: 15,
    title: 'REJECTED 版本经 13.3/13.4 访问返回 404',
    ref: '24.1 #15',
    kind: 'command',
    run: 'pnpm --filter @tps/db exec vitest run travel-plans-repository.integration --no-file-parallelism',
    needsDb: true,
  },

  // ── 新增门禁（V1.0 缺失）─────────────────────────────────
  {
    id: 16,
    title: 'T1/T2 分段 SLA（≤7 天：T1 P95 < 75 秒、T2 P95 < 110 秒）',
    ref: '24.1 #16、21.2',
    kind: 'manual',
    why: '分位数需要真实模型与足够样本量。已交付的是**度量手段**：generation_jobs 的 t1_at/t2_at 两列、travel_job_milestone_seconds 直方图、以及 21.3 的 SLA 违约告警规则。用 fake 模型跑出的 P95 只反映本机 CPU',
  },
  {
    id: 17,
    title: 'Hero 缓存命中率预热后 ≥ 80%',
    ref: '24.1 #17、21.2 措施二',
    kind: 'manual',
    why: '19.5 的 600 张预热需要真实图片模型与真实 place_id 清单，两者都不在代码侧。预热 CLI 已交付并在 --dry-run 下验证了键格式与规模；命中率由 travel_asset_cache_hit_ratio 记录规则与告警持续监控',
  },
  {
    id: 18,
    title: '中文字体渲染无豆腐块，字体断言 100% 通过',
    ref: '24.1 #18、17.5',
    kind: 'ci-only',
    why: 'L-04（fc-list 有 Noto）与 L-06（容器内非 root 完成渲染，含字形断言）在 CI 的 render job',
  },
  {
    id: 19,
    title: '单任务成本上限（AI 图片 ≤ 3 张、LLM ≤ 3 次调用）',
    ref: '24.1 #19、21.4',
    kind: 'command',
    run: 'pnpm test:acceptance',
    why: '20 个用例各自断言 distinct AI 素材数 ≤ 3 且 regeneration_count ≤ 2',
    needsDb: true,
  },
  {
    id: 20,
    title: '配额与限流（超额返回 429/AUTH_QUOTA_EXCEEDED，幂等命中不扣额）',
    ref: '24.1 #20、21.4',
    kind: 'command',
    run: 'pnpm --filter @tps/shared exec vitest run quota && pnpm --filter @tps/api exec vitest run travel-plans',
  },

  // ── R-13 / R-14 新增门禁 ─────────────────────────────────
  {
    id: 21,
    title: '匿名用户可直接生成（无 Cookie 的请求不返回 401）',
    ref: '24.1 #21、3.6、13.0',
    kind: 'command',
    run: 'pnpm test:acceptance',
    why: '10 个匿名用例都从「无身份 → GET /auth/session 自动建号 → 提交」走',
    needsDb: true,
  },
  {
    id: 22,
    title: '归属隔离对两类身份等强（匿名↔匿名、匿名↔注册全部 404）',
    ref: '24.1 #22、13.0',
    kind: 'command',
    run: 'pnpm --filter @tps/api exec vitest run travel-plans exports',
  },
  {
    id: 23,
    title: '匿名升级继承历史（user_id 前后一致，历史计划仍可见）',
    ref: '24.1 #23、13.9.2',
    kind: 'command',
    run: 'pnpm --filter @tps/db exec vitest run users.integration --no-file-parallelism && pnpm --filter @tps/api exec vitest run auth',
    needsDb: true,
  },
  {
    id: 24,
    title: '匿名归并幂等（重复执行无副作用，中途失败可重试）',
    ref: '24.1 #24、13.9.4',
    kind: 'command',
    run: 'pnpm test:merge',
    needsDb: true,
  },
  {
    id: 25,
    title: 'idempotency_key 归并后不重算（无唯一约束冲突，历史键保持原值）',
    ref: '24.1 #25、13.9.4',
    kind: 'command',
    run: 'pnpm test:idempotency',
    needsDb: true,
  },
  {
    id: 26,
    title: '全局检索跨身份生效（A 的投影能被 B 的生成命中）',
    ref: '24.1 #26、3.2.4',
    kind: 'command',
    run: 'pnpm test:e2e',
    why: '端到端里有一条专门的用例（落库的版本带投影与向量，且能被同城的相似计划检索到）',
    needsDb: true,
  },
  {
    id: 27,
    title: '检索投影脱敏完整（无日期、金额、人员构成、raw_text、任何 ID）',
    ref: '24.1 #27、3.2.4、15.2',
    kind: 'command',
    run: 'pnpm test:projection',
    needsDb: true,
  },
  {
    id: 28,
    title: 'L2 数据不出 API（13.3/13.4/13.9.5 响应无 retrieval_projection）',
    ref: '24.1 #28、二十章',
    kind: 'command',
    run: 'pnpm test:projection && pnpm --filter @tps/api exec vitest run travel-plans',
    needsDb: true,
  },
  {
    id: 29,
    title: '匿名数据保留与知识转存（到期清理、转存在删除之前、知识无标识符）',
    ref: '24.1 #29、15.1',
    kind: 'command',
    run: 'pnpm test:retention',
    needsDb: true,
  },
  {
    id: 30,
    title: '匿名防刷有效（IP 维度的创建限速与日生成总量兜底）',
    ref: '24.1 #30、21.4',
    kind: 'command',
    run: 'pnpm --filter @tps/shared exec vitest run quota && pnpm --filter @tps/api exec vitest run auth',
  },
  {
    id: 31,
    title: '匿名不可访问账号级端点（返回 403 AUTH_ANONYMOUS_FORBIDDEN）',
    ref: '24.1 #31、13.0',
    kind: 'command',
    run: 'pnpm --filter @tps/api exec vitest run auth',
  },
  {
    id: 32,
    title: 'Linux CI 全绿（L-01～L-10 十项）',
    ref: '24.1 #32、22.3.4',
    kind: 'ci-only',
    why: '镜像构建、容器内字体与 Chromium、/dev/shm 降级、SIGTERM 优雅退出都只能在 Linux 容器里验证。「本地跑通不算通过」在这一项是字面意义上的',
  },
  {
    id: 33,
    title: '视觉基线在 Linux 容器内生成，开发机产出的基线被拒绝',
    ref: '24.1 #33、22.3.4 L-08',
    kind: 'ci-only',
    why: 'CI 的 render job 含反向测试：把 render-meta.json 的 platform 改成 win32 后 visual:update 必须失败',
  },
  {
    id: 34,
    title: '优雅停机（生成中任务收 SIGTERM 后不留悬挂状态）',
    ref: '24.1 #34、22.3.3',
    kind: 'command',
    run: 'pnpm test:shutdown',
    why: '端到端测试起真实 Worker 子进程并发 SIGTERM。**在 Windows / macOS 上自动跳过**（那里没有 POSIX 信号，child.kill 映射到 TerminateProcess），因此本机看到的是「通过」但实际跳过 —— 真正执行它的是 CI 的 shutdown job（L-10）',
    needsDb: true,
  },

  // ── 24.1 的 V1.7 新增四项（R-45～R-52，随 P6 纳入）──────
  {
    id: 35,
    title: '搜索图入库合规（license_type 为空即丢弃；source_metadata 逐字段完整）',
    ref: '24.1 #35、9.6 的 R-46',
    kind: 'command',
    run: 'pnpm test:asset-ingest',
    why: '**不需要数据库**：仓储用进程内假实现，因此这一项总是真的在跑。做成集成测试的话，没有 DATABASE_URL 的环境里 vitest 会 describe.skip 并以 0 退出，于是报告把它算成通过（#34 就是这个问题）',
  },
  {
    id: 36,
    title: '搜索图复用与去重（第二次请求库内命中、图源零外呼；相同字节走标签并集）',
    ref: '24.1 #36、9.6 的 R-46/R-47',
    kind: 'command',
    run: 'pnpm test:asset-ingest',
    why: '同 #35 不需要数据库。SQL 侧的部分唯一索引由 pnpm test:integration 的 assets-repository 覆盖',
  },
  {
    id: 37,
    title: '通用空间隔离与归并零搬运（匿名 A 拿不到匿名 B 的产物；归并后对象无拷贝/重命名）',
    ref: '24.1 #37、15.4 的 R-49/R-50',
    kind: 'command',
    run: 'pnpm test:storage-keys && pnpm test:merge',
    why: '前半（隔离）由 15.4 键构造器的纯函数测试 + api 的 exports 越权用例覆盖；后半（零搬运）由归并集成测试的对象存储操作计数断言覆盖 —— 「零」只能靠计数，看最终状态看不出中间有没有搬过',
    needsDb: true,
  },
  {
    id: 38,
    title:
      '清理以归属为准（已归并用户的 anon/ 对象不被误删；纯匿名到期对象被删；anon/ 前缀无生命周期规则）',
    ref: '24.1 #38、15.1 的 R-50/R-51',
    kind: 'command',
    run: 'pnpm test:retention',
    why: '含三类断言：删对象在删行之前的顺序、MERGED 行不进清理路径的回归断言、生命周期规则声明的文本层断言（本机没有 mc，与 P5 对 Helm 的处理同一形态）',
    needsDb: true,
  },
];

/** 24.1 的项数。写成常量供自检，防止无意增删 */
export const GATE_COUNT = 38;
