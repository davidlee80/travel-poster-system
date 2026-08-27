/**
 * 验收门禁清单（TP-5-06；#35～#38 随 P6 的 TP-6-17 纳入，
 * #39/#40 随 P8，#41～#43 随多模型故障转移）。
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
    title: 'T1/T2 分段 SLA（≤7 天：T1 P95 < 75 秒、T2 P95 < 155 秒）',
    ref: '24.1 #16、21.2',
    kind: 'manual',
    why: '分位数需要真实模型与足够样本量。已交付的是**度量手段**：generation_jobs 的 t1_at/t2_at 两列、travel_job_milestone_seconds 直方图、以及 T1/T2 两条 SLA 违约告警。**T2 从 110 调到 155** 是多模型故障转移的显式决定：素材窗口从 35 秒放宽到 80 秒（40 秒/候选 × 2），155 = 75 + 80。用 fake 模型跑出的 P95 只反映本机 CPU',
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
    title: 'P7：未注册请求被拒（无 Cookie 与匿名 Cookie 均返回 401，且不建号）',
    ref: '24.1 #21、3.6、13.0（P7 反转）',
    kind: 'command',
    run: 'pnpm test:identity',
    why: 'P7 反转了 13.0 第 3.a 条。原断言是「匿名可直接生成」，现在断言的是「一律拒绝」：service 的 6 条关闭态用例 + auth 路由的 5 条端点用例，覆盖「无 Cookie 不建号」「带存量 tp_anon 被拒且 Cookie 被清除」两条。开关打开时的旧行为由同文件的 27 条双模式用例保住 —— 两个方向的断言并存是刻意的，重新打开匿名时不需要重写测试',
    needsDb: true,
  },
  {
    id: 22,
    title: '归属隔离生效（注册↔注册全部 404；开关打开时匿名↔注册同样等强）',
    ref: '24.1 #22、13.0',
    kind: 'command',
    run: 'pnpm --filter @tps/api exec vitest run travel-plans exports',
    why: 'P7 之后前端只有注册身份，因此实际生效的是注册↔注册那一格。矩阵的其余三格（匿名↔匿名、匿名↔注册双向）仍在同一批用例里 —— 它们构造身份时走服务层，与匿名入口的开关无关。保留而非删除：越权隔离是安全断言，缩小它的覆盖面需要比「入口关了」更强的理由',
  },
  {
    id: 23,
    title: '匿名升级继承历史（user_id 不变，历史仍可见）—— P7 后仅服务/仓储层可达',
    ref: '24.1 #23、13.9.2',
    kind: 'command',
    run: 'pnpm --filter @tps/db exec vitest run users.integration --no-file-parallelism && pnpm --filter @tps/api exec vitest run auth',
    why: 'P7 关闭了这条能力的 API 入口（register 不再走原地升级分支），但 upgradeAnonymous 与其仓储测试都保留。保留断言而不是删掉：删掉正是 P4/P5 反复记录的那类缺口 —— 东西还在库里，但没有任何东西能到达它，于是它悄悄坏掉也没人知道。这一项同时是「重新打开匿名」的验收前提',
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
    title: 'P7：匿名入口关闭时不产生任何匿名行；IP 维度日生成总量兜底仍生效',
    ref: '24.1 #30、21.4',
    kind: 'command',
    run: 'pnpm --filter @tps/shared exec vitest run quota && pnpm --filter @tps/api exec vitest run auth',
    why: 'P7 让原断言的前半（清 Cookie 反复建号被 IP 限速拦住）不可达 —— 建号入口本身关了，比限速更彻底。因此改为断言「关闭时一个匿名行都不产生」（service 与 auth 各有一条用例用行数判定）。后半（单 IP 日生成总量兜底）不变：它对注册用户同样生效，而那正是它当初被设计成 IP 维度而非身份维度的理由',
  },
  {
    id: 31,
    title: '匿名不可访问账号级端点（403 AUTH_ANONYMOUS_FORBIDDEN）—— P7 后仅服务层可达',
    ref: '24.1 #31、13.0',
    kind: 'command',
    run: 'pnpm --filter @tps/api exec vitest run auth',
    why: 'P7 之后匿名身份到不了这些端点（在身份解析阶段就被拒了），因此 403 AUTH_ANONYMOUS_FORBIDDEN 在生产上不可达。断言保留：它验的是服务层的拦截逻辑，而那一层在开关打开时立刻重新生效',
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
  {
    id: 39,
    title: '条件字典、分域表与中文文案三处一致',
    ref: 'P8 / R-55、P9 / R-65，设计稿 5.1',
    kind: 'command',
    run: 'pnpm --filter @tps/schemas exec vitest run conditions && pnpm --filter @tps/presentation exec vitest run condition-labels',
    why: '5.1 的失效方式是静默的：漏配一个 code 的文案会让表单出现没有文字的标签，把 code 归错域会让它不进 Prompt 的对应小节 —— 两者都不报错。文案表是 Record<ConditionCode,…>，因此漏配是编译错误；这条门禁守的是分域条目数与「正向命名」两条约定。**标题刻意不写字典总数**：它已经陈旧过一次（写着 46 而实际是 61，而门禁照样绿着）。权威数字在 CONDITION_CODE_COUNT 与 conditions.test.ts 的逐域断言里 —— 那里写错会变红，而标题写错不会',
  },
  {
    id: 40,
    title: '契约夹具通过校验，且校验器自身有效',
    ref: 'P8 / R-56',
    kind: 'command',
    run: 'pnpm test:contract',
    why: '前端呈现层可整体替换，替换者靠 pnpm validate:request 自证请求合法。一个恒返回 0 的校验器会让所有模板都「通过」而失效完全静默，因此 --self-test 用三项反证（缺 basis、未知 code、v2 版本号）确认它真的会拒。两份夹具分别覆盖最小必填集与全量可选项',
  },

  // ── 多模型故障转移与超时分层（迁移 0009）──────────────────
  {
    id: 41,
    title: '候选池未配置时行为与迁移前一致（两张表为空 → 回落 env 单模型）',
    ref: '多模型 failover 计划第 3 节',
    kind: 'command',
    run: 'pnpm --filter @tps/generation-worker exec vitest run model-selection',
    why: '这一项是整个特性能否渐进启用、回滚是否需要动代码的唯一保证。失效的表现是「迁移完还没配任何池，AI 素材就全没了」—— 而那时会被当成模型故障去查。**不需要数据库**：仓储用进程内假实现，包括「读库抛错也回落」那条',
  },
  {
    id: 42,
    title: '区间匹配与截断（tier 15 落到 10 那一档；max_candidates=10 被削到 2 且可见）',
    ref: '多模型 failover 计划第 2、3 节',
    kind: 'command',
    run: 'pnpm --filter @tps/generation-worker exec vitest run model-selection model-pool-cli && pnpm --filter @tps/db exec vitest run model-pools.test',
    why: '区间匹配是选整数等级而非枚举的全部收益：破了的话运营每加一档都得同时加映射，而漏加的表现是「那批用户静默回落到单模型」。截断这一半守的是可见性 —— 静默截断会让运营以为配置生效了，然后花几天调查「为什么候选数调上去成功率没变」。SQL 侧的区间匹配另由 pnpm test:integration 的 model-pools 覆盖',
  },
  {
    id: 43,
    title: '时延闸生效（累计耗时达上限 → JOB_AI_TIME_EXHAUSTED 进 warnings 而非错误）',
    ref: '多模型 failover 计划第 0、1 节',
    kind: 'command',
    run: 'pnpm --filter @tps/generation-worker exec vitest run ai-budget ai-generator',
    why: '21.4 的「3 张」与 21.2 的「Hero 2 次」都是用次数近似时延，而那个近似的前提是「一次生成最多 20 秒」这个硬编码常量。超时可配之后次数只剩成本含义 —— 没有这一项，T2 的窗口就没有任何东西在守。同批还含「整条候选链失败只记 1 次 failure」：按候选记的话 MAX_AI_FAILURES_PER_JOB=2 会让 failover 跑不完一轮',
  },

  // ── P9 Planner V2.1（迁移 0010～0012）─────────────────
  {
    id: 44,
    title: '契约地基：76 字段元数据与载荷路径恒等式',
    ref: 'P9 / R-73，设计稿 5.2',
    kind: 'command',
    run: 'pnpm --filter @tps/schemas exec vitest run planner-fields planner-profile',
    why: '守的是一条恒等式：76 个字段的载荷路径 ≡ planner_profile. + api_key（双向断言，缺字段与多余叶子键都报错）。破了之后的表现不是报错，是「用户填了档次，生成时读到 undefined」—— 而那正是当初不维护别名表而改用新顶层块的理由。同批还含分域数量逐行（14/11/19/4/4/7/2）与**隐私禁词扫描**（叶子路径无 passport_number / card_number / cvv 等 12 个）—— 后者坏了的表现是我们收了护照号而没人发现',
  },
  {
    id: 45,
    title: '界面绑定完整：76 个绑定可被识别，无重叠无遗漏',
    ref: 'P9 规范 21.1 硬门槛，设计稿 5.2',
    kind: 'command',
    run: 'pnpm --filter @tps/web exec vitest run sections descriptors',
    why: '区块表逐组拼起来必须**逐个相等**于 fieldsOfStep(step)，且九步 70 + 准备中心 6 的并集 = 76、两边无重叠。靠元数据表而不是逐个组件罗列字段，因为两份清单必然漂移 —— 而漂移的表现是「产品加了一个字段，某一步没有它」，而那一步看起来完整',
  },
  {
    id: 46,
    title: '配置中心与内置字典双向一致（P9 陷阱 1）',
    ref: 'P9 实施计划「陷阱 1」，设计稿 5.1 / 5.2',
    kind: 'command',
    run: 'pnpm --filter @tps/api exec vitest run planner-config',
    why: 'N-08 的判据是 allowedConditionCodes?.has(code) ?? isKnownConditionCode(code) —— `??` **不是并集**，一旦库里有已发布配置，内置字典完全不参与判断。新码只加进 conditions.ts 而没注册进 planner_config_options 就会被拒，而界面上那个标签完全正常。P9-6 期间就因此发现过一个更严重的存量缺陷：筛选用的是 endsWith(".tags") 而 8 个字段里有 5 个是 _tags 结尾 —— 于是装了配置中心的环境里 P8 自己的 26 个码全部被 N-08 拒掉。本地开发与单测不装配置中心，因此它在开发期完全不可见',
  },
  {
    id: 47,
    title: '配置驱动真的生效（派生键 ⇄ 迁移注册，含停用/改文案/改排序）',
    ref: '设计稿 5.2、docs/规划器配置中心.md',
    kind: 'command',
    run: 'pnpm --filter @tps/web exec vitest run config-binding config-driven',
    why: '从描述符表**派生**的 62 个 field_key ⇄ 迁移 0012 注册的行（双向且含顺序），kind 与 metadata.value_kind 一致，投影专用键下恰好是界面上没有标签的那 18 个码。派生而不是手写映射表：手写的那份与描述符漂移无法被发现 —— 描述符里新加一个带选项的部件、忘了补映射，那个列表就静默退回硬编码，运营改了没生效而界面看起来完全正常',
  },
  {
    id: 48,
    title: '多城与弹性日期：V-04 集合校验、单城恒等、N-09/N-10/N-13/N-14',
    ref: 'P9 / R-61～R-63、R-67，设计稿 3.1.2 / 3.2.1.2',
    kind: 'command',
    run: 'pnpm --filter @tps/planning exec vitest run conflicts && pnpm --filter @tps/presentation exec vitest run cities',
    why: '不改 V-04 的后果不是「校验不住」而是比那严重得多：trip.destination 永远是单个，因此一份「东京 + 京都」行程里第 2～5 城的所有日子都会被判违规，然后被修复动作逐日覆写成第一个城市 —— 用户拿到全程东京的计划，而校验与修复都报告成功。「单城行为一字未变」那一条同样要守：它是视觉基线在 P9 下保持 0.0000% 的原因（planCities 对存量行退化成单元素序列）。V-04 的集合校验与修复策略另由 pnpm test:validation 覆盖',
  },

  // ── CR 计费（迁移 0013～0014）──────────────────────
  {
    id: 49,
    title: '钱包不变量：结算幂等、并发预留守恒、六道约束',
    ref: '设计稿 21.5 不变量一 / 二，docs/用户货币与计费.md §七',
    kind: 'command',
    run: 'pnpm --filter @tps/db exec vitest run credit-wallet.integration --no-file-parallelism',
    why: '幂等键 job:<job_id> 是整套计费设计里最重要的约束：生成任务会被重投（队列重试、worker 崩溃后接管），没有它一次重投就是一次重复扣费 —— 而用户不会因为「少了 2000 CR」来提工单，他只会觉得这个产品贵。同批含并发预留（余额只够一次 → 恰好一个成功、balance_cr + held_cr 守恒）与六道数据库约束。**必须标 needsDb**：无 DATABASE_URL 时 35 个用例全 skip 而退出码是 0，不标的话报告会把“什么都没验”算成通过 —— 而这是全清单里最不能被误报成绿的一项，它管的是钱',
    needsDb: true,
  },
  {
    id: 50,
    title: '预留生命周期：可重试不释放、失败全退、导出退原额',
    ref: '设计稿 21.5 不变量三，docs/用户货币与计费.md §四 / §五',
    kind: 'command',
    run: 'pnpm --filter @tps/generation-worker exec vitest run billing && pnpm --filter @tps/render-worker exec vitest run billing',
    why: '可重试的失败**保留**预留 —— 释放了的话重试成功时结算找不到 ACTIVE 的预留，按设计它不扣费，于是「失败一次然后成功」的任务全部免费。PLAN_LLM_TIMEOUT / PLAN_LLM_UNAVAILABLE 导致的重试并不罕见，这会是一个持续漏钱且完全不可见的洞。导出侧守的是「退多少只有一个正确答案：当时实际扣的那个数」—— 按当前价目现算在调价窗口内会退错，而少退是我们赖账、多退是可以被反复触发的漏洞',
  },
  {
    id: 51,
    title: '定价安全网：兜底价命中、估算参数 ≥ 真实常量、开发期上界 ≤ 赠送额',
    ref: 'docs/用户货币与计费.md §三 / §九，设计稿 21.5',
    kind: 'command',
    run: 'pnpm --filter @tps/billing exec vitest run billing dev-prices && pnpm --filter @tps/generation-worker exec vitest run billing-limits',
    why: '三条都是静默的。兜底价：没它会让任务卡在终态之前（用户的计划已经生成好了却永远看不到），而兜底按 0 会让那个模型完全免费且没有任何人会发现。估算参数用 >= 而不是 ===：允许 billing 保守，不允许它乐观（乐观 → 预留不足 → 坏账）。开发期定价那一条断言「任何天数、任何重生成次数下的最坏上界 ≤ 注册赠送额」—— 只保证典型值不超不够，那会让「重生成两次」变成一个只在特定条件下出现的 402，而它恰恰最难复现。dev-prices.test.ts **直接解析迁移 SQL**，不在测试里抄一份数字 —— 抄的话漂移方向恰好最坏：测试说能跑通，库里那一版跑不通',
  },
  {
    id: 52,
    title: '开关与身份边界：关闭时钱包表一次不读、/credits/* 拒匿名、赠送只发一次',
    ref: '设计稿 21.5 不变量五 / 六，13.9.1',
    kind: 'command',
    run: 'pnpm --filter @tps/api exec vitest run credits travel-plans exports',
    why: '开关那条不是静默而是灾难性的，但**它只在生产的特定部署顺序下出现**：钱包与价目表到 0013 才建立，而应用与数据库的部署不是原子的 —— 装配了却没迁移的后果是每个生成请求都撞 relation credit_wallets does not exist，也就是全站不可用。本地永远看不到它，因此只能靠「未装配计费时不碰钱包」那两条断言守。赠送那条是静默的：幂等键 signup:<user_id> 与匿名原地升级走同一个 user_id，做错会让「先匿名生成再注册」多拿一次',
  },

  // ── 样式作用域（P9-2）──────────────────────────
  {
    id: 53,
    title: 'planner.css 的选择器全部以 .planner 开头',
    ref: 'P9 Global Constraints，设计稿 5.2',
    kind: 'command',
    run: 'pnpm test:css-scope',
    why: 'globals.css 由根 layout 引入，而 /render/** 的信息图页面是它的后代。写到 body / :root 会让导出 PNG 底色从白变灰、字体绕过 @tps/fonts 的自托管子集 —— 两者的共同点是**采集页面看起来完全正常**，坏掉的是另一条链路上的产物。P9-8 手工核对过一次（当时 319 条全合格），但那是一次性的：下一个改样式的人不会知道有这条纪律，而违反它除了视觉基线之外不会让任何测试变红（而那条的报错指向截图差异，不指向这里）。--self-test 用 6 个必须检出 + 7 个必须放过的样本反证扫描器本身没失效，并带一条选择器数量下限（低于 200 直接报错）—— 一个解析不到东西的扫描器会把「0 处违规」当成通过',
  },
];

/**
 * 24.1 的项数。写成常量供自检，防止无意增删。
 *
 * 24.1 原表是 38 项；P8 加 #39/#40，多模型故障转移加 #41～#43，
 * P9 加 #44～#48、CR 计费加 #49～#52、样式作用域加 #53。
 * 后十五项本来不在设计稿里（与 METRICS_CATALOG 的 `source: 'supplementary'` 同一处理），
 * 设计稿 V1.9 的 R-66 与 V1.11 的 R-77 已把它们登记进 24.1 的「设计稿之外的补充门禁」一节 ——
 * 因此两边现在都是 53。两个数字不等时，「现在是全绿吗」这个问题没有确定的答案。
 */
export const GATE_COUNT = 53;
