import type { FullPlanViewModel } from '@tps/presentation';
import { Icon } from '@/components/Icon';
import { BlueprintDaily } from '@/templates/blueprint-v1/daily';
// 套件级配色与字体角色，与日页共用（R-85 P2）
import '../tokens.css';
import './styles.css';

/**
 * blueprint_v1 —— 全览页（R-85 P2）。
 *
 * 与每日页的两点关键区别（与 ink_paper 的全览页同一条道理）：
 *
 * 1. **响应式**。每日页是定宽 1200px 的导出产物；全览页是浏览页面，
 *    需要在 320px～1920px 之间可用。因此它有自己的样式表，只在容器层
 *    做响应式，各日内容仍复用 `BlueprintDaily`。
 *
 * 2. **不裁剪内容**。`content_limits` 全为 null（3.3.1），因此不传
 *    `compact` / `hideBelowPriority` —— 全览页有纵向空间，没有溢出压力。
 *
 * ## 与 ink_paper 全览页的布局差异
 *
 * ink_paper 的全览页是「标题 + 事实卡 + 导航 + 各日」的纵向流。
 * 这里改成**索引表**：概览做成图纸的标题栏（标签/值网格），
 * 按天跳转做成带编号的表格行而不是卡片 —— 与每日页的编号区块呼应。
 */

export interface BlueprintFullPlanProps {
  readonly viewModel: FullPlanViewModel;
}

export function BlueprintFullPlan({ viewModel: vm }: BlueprintFullPlanProps) {
  return (
    <div className="bp-doc" data-template={vm.template_id} data-page-type={vm.page_type}>
      <header className="bp-doc__title">
        <div className="bp-doc__heading">
          <p className="bp-doc__eyebrow">{vm.overview.destination}</p>
          <h1 className="bp-doc__h1">{vm.overview.title}</h1>
          <p className="bp-doc__summary">{vm.overview.summary}</p>
        </div>

        {/* 概览做成图纸标题栏的标签/值网格 */}
        <dl className="bp-doc__specs">
          <Spec icon={vm.icons.schedule} label="日期" value={vm.overview.date_range_text} />
          <Spec icon={vm.icons.route} label="天数" value={`${vm.overview.total_days} 天`} />
          <Spec icon={vm.icons.tips} label="人数" value={vm.overview.traveler_text} />
          <Spec icon={vm.icons.budget} label="预算" value={vm.overview.per_person_text} />
        </dl>
      </header>

      {/* 索引表：带编号的行，而不是卡片 */}
      <nav className="bp-doc__index" aria-label="按天跳转">
        {vm.days.map((day, index) => (
          <a
            key={day.day_number}
            className="bp-doc__index-row"
            href={`#day-${day.day_number}`}
          >
            <span className="bp-doc__index-no">{String(index + 1).padStart(2, '0')}</span>
            <span className="bp-doc__index-day">{day.header.day_label}</span>
            <span className="bp-doc__index-theme">{day.header.title}</span>
          </a>
        ))}
      </nav>

      <div className="bp-doc__sheets">
        {vm.days.map((day) => (
          <section
            key={day.day_number}
            id={`day-${day.day_number}`}
            className="bp-doc__sheet"
            // 每日一页（17.4 PDF 分页控制）
            style={{ breakAfter: 'page' }}
          >
            <div className="bp-doc__sheet-frame">
              <BlueprintDaily viewModel={day} />
            </div>
          </section>
        ))}
      </div>

      <footer className="bp-doc__strip">
        <span>
          {vm.overview.destination} · 共 {vm.overview.total_days} 天 · 合计{' '}
          {vm.overview.total_budget_text}
        </span>
        <span className="bp-doc__strip-id">{vm.template_id}</span>
      </footer>
    </div>
  );
}

function Spec({ icon, label, value }: { icon: string; label: string; value: string }) {
  return (
    <div className="bp-doc__spec">
      <Icon name={icon} size={16} className="bp-doc__spec-icon" />
      <dt className="bp-doc__spec-label">{label}</dt>
      <dd className="bp-doc__spec-value">{value}</dd>
    </div>
  );
}
