import { Planner } from '@/components/planner/Planner';
import { SessionProvider } from '@/components/SessionProvider';
import { PlannerConfigProvider } from '@/components/planner/PlannerConfigProvider';

/**
 * 首页：需求采集工作台（TP-8-07）。
 *
 * P8 之前这里是一张单列长表单（`PlanRequestForm`）。现在换成原型的三栏
 * 八步工作台 —— 46 个条件标签散在一张长表单里，用户翻到底时已经不记得
 * 上面勾了什么，而右栏摘要正是为此存在。
 *
 * `AnonymousNotice` 不再挂在这里：P7 关闭匿名入口后未注册请求一律 401，
 * 该提示条对 `anonymous` 态本来就不渲染，因此它在默认配置下从 P7 起就已经
 * 是不可见的。登录引导改由右栏提交按钮下方那句说明承担 ——
 * 就在用户想点提交的那个位置。
 *
 * **组件文件保留**：它是 `pnpm test:docs` 的锚点（保留期天数在隐私政策与界面
 * 文案里必须是同一个数字，见 observability/src/runbook.test.ts）。
 * 重新打开匿名入口时（运维手册「重新打开匿名入口」一节），把它加回这里。
 */
export default function HomePage() {
  return (
    <SessionProvider>
      <PlannerConfigProvider>
        <Planner />
      </PlannerConfigProvider>
    </SessionProvider>
  );
}
