import type { FullPlanViewModel } from '@tps/presentation';
import { Icon } from '@/components/Icon';
import { TravelInfographic } from '@/templates/ink-paper-v1/daily';
import './styles.css';

/**
 * travel_full_plan_v1 —— 响应式完整计划页（TP-1-06，设计稿 1.1、3.3.1）。
 *
 * 与每日信息图的两点关键区别：
 *
 * 1. **响应式**。信息图是定宽 1200px 的导出产物；完整页是浏览页面，
 *    需要在 320px～1920px 之间可用。因此它有自己的样式表，只在容器层
 *    做响应式，各日内容仍复用 `TravelInfographic`。
 *
 * 2. **不裁剪内容**。`content_limits` 全为 null（3.3.1），因此不传
 *    `compact` / `hideBelowPriority` —— 完整页有纵向空间，没有溢出压力。
 */

export interface TravelFullPlanProps {
  readonly viewModel: FullPlanViewModel;
}

export function TravelFullPlan({ viewModel: vm }: TravelFullPlanProps) {
  return (
    <div className="full-plan" data-template={vm.template_id} data-page-type={vm.page_type}>
      <header className="full-plan__head">
        <p className="full-plan__eyebrow">{vm.overview.destination}</p>
        <h1 className="full-plan__title">{vm.overview.title}</h1>
        <p className="full-plan__summary">{vm.overview.summary}</p>

        <dl className="full-plan__facts">
          <Fact icon={vm.icons.schedule} label="日期" value={vm.overview.date_range_text} />
          <Fact icon={vm.icons.route} label="天数" value={`${vm.overview.total_days} 天`} />
          <Fact icon={vm.icons.tips} label="人数" value={vm.overview.traveler_text} />
          <Fact icon={vm.icons.budget} label="预算" value={vm.overview.per_person_text} />
        </dl>
      </header>

      <nav className="full-plan__nav" aria-label="按天跳转">
        {vm.days.map((day) => (
          <a key={day.day_number} className="full-plan__nav-link" href={`#day-${day.day_number}`}>
            <span className="full-plan__nav-day">{day.header.day_label}</span>
            <span className="full-plan__nav-theme">{day.header.title}</span>
          </a>
        ))}
      </nav>

      <div className="full-plan__days">
        {vm.days.map((day) => (
          <section
            key={day.day_number}
            id={`day-${day.day_number}`}
            className="full-plan__day"
            // 每日一页（17.4 PDF 分页控制）
            style={{ breakAfter: 'page' }}
          >
            <div className="full-plan__day-frame">
              <TravelInfographic viewModel={day} />
            </div>
          </section>
        ))}
      </div>

      <footer className="full-plan__footer">
        <span>
          {vm.overview.destination} · 共 {vm.overview.total_days} 天 · 合计{' '}
          {vm.overview.total_budget_text}
        </span>
        <span>{vm.template_id}</span>
      </footer>
    </div>
  );
}

function Fact({ icon, label, value }: { icon: string; label: string; value: string }) {
  return (
    <div className="full-plan__fact">
      <Icon name={icon} size={18} className="full-plan__fact-icon" />
      <dt className="full-plan__fact-label">{label}</dt>
      <dd className="full-plan__fact-value">{value}</dd>
    </div>
  );
}
