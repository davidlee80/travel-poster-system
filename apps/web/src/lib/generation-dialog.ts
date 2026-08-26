/**
 * 生成等待弹层的视图推导（设计稿 13.2、16.1、21.2 措施一）。
 *
 * ## 为什么单独一个纯模块
 *
 * apps/web 的 vitest 环境是 `node`，没有 jsdom 也没有 testing-library ——
 * 组件本身测不了。而这里真正容易错的不是 DOM，是**每个阶段该说哪两句话、
 * 进度条该显示多少**：`ready` 是在 `SAVING_PLAN` 就触发的（见 Planner 的
 * `READABLE_STATUSES`），那时后端的 `progress` 可能才 60 —— 直接用它会让
 * 用户看到「已完成 60%」旁边写着「行程已生成」。
 *
 * 把这部分拿出来做成纯函数，它就能被测；组件只负责把结果摆上去。
 *
 * ## 两行文字的分工
 *
 * ```text
 * 第 1 行   现在在做什么   —— 取 13.2 的 message，随阶段变化
 * 第 2 行   我还要等多久   —— 稳定文案，回答「能不能走开」
 * ```
 *
 * 合成一行的话第二类信息就没地方放了，而它恰恰是用户在等待时最想知道的。
 * 反过来两行都动态也不行：一句每两秒重写一次的提示读不完。
 */

export type GenerationPhase =
  | { readonly kind: 'idle' }
  | { readonly kind: 'submitting' }
  | { readonly kind: 'generating'; readonly progress: number; readonly message: string }
  | { readonly kind: 'ready'; readonly planId: string }
  | {
      readonly kind: 'error';
      readonly message: string;
      readonly retryable: boolean;
      /**
       * 是否是「未登录 / 会话失效」类失败（HTTP 401）。
       *
       * 单独一位而不是只看 `retryable`：401 也是 `retryable: false`，于是它会
       * 和「日期非法」「预算太低」共用第二行文案「请按上面的提示调整条件」
       * —— 而未登录不是条件问题，调整条件一万次也不会好。
       */
      readonly needsAuth?: boolean;
      /**
       * CR 余额不足时还差多少（HTTP 402 的 `details`，C-6）。
       *
       * 又一位而不是复用 `retryable: false`：那一档给的建议是「按提示调整
       * 条件」，而余额不足调一万次条件也不会好 —— 与 `needsAuth` 是同一类
       * 错误建议。有它才能说出真正的下一步。
       */
      readonly shortfallCr?: number;
    };

export interface GenerationDialogView {
  readonly tone: 'working' | 'done' | 'error';
  readonly title: string;
  /** 进度条上方的两行。顺序固定：先「在做什么」，后「还要多久」 */
  readonly lines: readonly [string, string];
  /**
   * 进度。三种取值，各对应一种不同的显示：
   *
   * ```text
   * number           画到那个百分比
   * 'indeterminate'  画一根来回扫的跑马灯 —— 提交阶段还没有 job_id 可查，
   *                  而一根停在 0% 的静止条会被读成「卡住了」
   * null             **不显示进度条**
   * ```
   *
   * 前两者曾经共用 `null`，结果失败弹层上挂着一根还在扫的跑马灯 ——
   * 读起来像「仍在工作」，与「已经失败了」正好相反。这是三态而不是两态。
   */
  readonly percent: number | 'indeterminate' | null;
  /**
   * 是否允许关闭。
   *
   * 生成中一律不允许：轮询挂在 Planner 上，关掉弹层它还在跑，但用户再也
   * 看不到结果 —— 那比不给关闭按钮更糟。等到 `ready` / `error` 才放开。
   */
  readonly dismissible: boolean;
  /** `ready` 时的跳转目标，其余阶段为 null */
  readonly planId: string | null;
}

/** 生成通常要多久。这个数字对着 21.2 的 T1 目标（P95 < 75 秒）写 */
const WAIT_HINT = '通常一分钟左右完成，期间请不要关闭页面。';

/**
 * `idle` 返回 null —— 弹层根本不该出现。
 *
 * 用 null 而不是给一个 `visible: false` 字段：后者会让调用方多一个
 * 可以忘记检查的分支，而「拿到对象就渲染」是不会写错的。
 */
export function dialogViewFor(phase: GenerationPhase): GenerationDialogView | null {
  switch (phase.kind) {
    case 'idle':
      return null;

    case 'submitting':
      return {
        tone: 'working',
        title: '正在提交',
        lines: ['正在把你的旅行需求发给生成服务…', '这一步很快，随后会显示生成进度。'],
        percent: 'indeterminate',
        dismissible: false,
        planId: null,
      };

    case 'generating':
      return {
        tone: 'working',
        title: '正在生成你的行程',
        /*
         * 第一行直接用 13.2 的 message，不自己拼。那句话是后端按当前状态给的
         * 用户文案（16.1 的状态机每一档都有），前端另写一套只会与它漂移 ——
         * 而漂移的表现是「进度条走到 80% 了，文字还停在正在检索」。
         */
        lines: [phase.message, WAIT_HINT],
        percent: clampPercent(phase.progress),
        dismissible: false,
        planId: null,
      };

    case 'ready':
      return {
        tone: 'done',
        title: '行程已生成',
        /*
         * 第二行说明配图还没好，是因为 `ready` 触发于 `SAVING_PLAN`
         * （21.2 措施一的 T1：文字版可读就放人走，不等素材）。
         * 不说的话用户点进去看到占位图，会当成生成失败。
         */
        lines: ['文字版完整计划已经可以查看了。', '配图与长图仍在后台生成，稍后刷新页面即可看到。'],
        // 到这一步进度条必须满格：后端此刻的 progress 可能才 60 多
        percent: 100,
        dismissible: true,
        planId: phase.planId,
      };

    case 'error':
      return {
        tone: 'error',
        title: '生成未完成',
        lines: [phase.message, errorHint(phase)],
        // 失败态不画进度条：一根扫来扫去的跑马灯读起来是「还在工作」
        percent: null,
        dismissible: true,
        planId: null,
      };
  }
}

/**
 * 第二行：该怎么办。
 *
 * 三档而不是两档。`needsAuth` 必须先判 —— 401 同样是 `retryable: false`，
 * 落到「请按上面的提示调整条件」那一档时给的是错误建议：用户会去改日期、
 * 改预算，而真正要做的是登录。
 *
 * 「已填写的内容不会丢」是必须说的：关掉弹层去登录时表单状态确实还在
 * （`Planner` 的 reducer 不因 401 重置），不说的话用户不敢关。
 */
function errorHint(phase: {
  readonly retryable: boolean;
  readonly needsAuth?: boolean;
  readonly shortfallCr?: number;
}): string {
  if (phase.needsAuth === true) {
    return '在右上角登录后可以直接重新提交，已填写的内容不会丢。';
  }
  if (phase.shortfallCr !== undefined) {
    /*
     * 不写「请去充值」：支付入口本轮不存在（见 docs 的「明确不在范围」）。
     * 指一个不存在的入口，用户会在界面上找它，找不到之后才是真正的困惑。
     */
    return (
      `还差 ${phase.shortfallCr} CR。充值入口内测期尚未开放，` +
      '可联系我们补充额度；已填写的内容不会丢。'
    );
  }
  return phase.retryable ? '这类问题多是临时的，可以直接重试。' : '请按上面的提示调整条件后再试。';
}

/**
 * 百分比取值收进 0～100 的整数。
 *
 * 16.2 保证 `progress` 单调不减，但保证不了它的上下界 —— 而一个 120 会让
 * 进度条的填充块溢出圆角容器，一个负数会让它反向。这类越界只会在某次
 * 状态机改动之后偶发，而 CSS 层面看不出是数据问题。
 */
function clampPercent(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.min(100, Math.max(0, Math.round(value)));
}
