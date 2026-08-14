import type { TravelPosterViewModel } from '@tps/schemas';
import { Icon } from '@/components/Icon';
import { guard } from './overflow-guards';
import './styles.css';

/**
 * travel_infographic_v1 —— 每日信息图模板（TP-1-05，设计稿十二章）。
 *
 * ## 模板不做任何数据加工
 *
 * 全部展示文案在 ViewModel 里已是最终中文（12.1 的派生规则在
 * `@tps/presentation` 中完成）。模板只负责布局，因此：
 *   - 没有枚举映射、没有金额格式化、没有字符串截断；
 *   - 模板的 bug 只会是布局问题，不会是数据问题；
 *   - 换模板不需要重新实现一遍文案规则。
 *
 * ## 两处与 17.3 的契约
 *
 * 1. 核心元素带 `data-overflow-guard` + `data-overflow-priority`；
 * 2. `compact` 为 true 时切换到 `*_compact` 文案（第 2 轮重渲染）；
 *    `variant='relaxed'` 时切换宽松版式（第 4 轮）。
 */

export interface TravelInfographicProps {
  readonly viewModel: TravelPosterViewModel;
  /** 17.3 第 2 轮：启用压缩文案 */
  readonly compact?: boolean;
  /** 17.3 第 3 轮：隐藏低于此优先级的条目（`null` 表示不隐藏） */
  readonly hideBelowPriority?: number | null;
  /** 17.3 第 4 轮：宽松版式 */
  readonly variant?: 'default' | 'relaxed';
}

export function TravelInfographic({
  viewModel: vm,
  compact = false,
  hideBelowPriority = null,
  variant = 'default',
}: TravelInfographicProps) {
  const visible = (priority: number): boolean =>
    hideBelowPriority === null || priority >= hideBelowPriority;

  const text = (full: string, short: string): string => (compact ? short : full);

  return (
    <article
      className="poster"
      data-variant={variant}
      data-template={vm.template_id}
      data-page-type={vm.page_type}
      data-day={vm.day_number ?? ''}
    >
      <Hero vm={vm} compact={compact} />

      <div className="body">
        {vm.schedule.length > 0 && (
          <section>
            <SectionHead icon={vm.icons.schedule} title="今日行程" />
            <div className="schedule">
              {vm.schedule.map((item, index) => (
                <div
                  key={`${item.title}-${index}`}
                  className="schedule__item"
                  {...guard('scheduleItem')}
                >
                  <span className="schedule__period">
                    <Icon name={item.period_icon} size={18} />
                    {item.period}
                  </span>
                  <div>
                    <h3 className="schedule__title">{item.title}</h3>
                    <p className="schedule__desc">
                      {text(item.description, item.description_compact)}
                    </p>
                  </div>
                  <span className="schedule__duration">{item.duration_text}</span>
                </div>
              ))}
            </div>
          </section>
        )}

        <section>
          <SectionHead icon={vm.icons.map} title="路线" />
          <RouteMap vm={vm} />
          {vm.route_recommendations.length > 0 && (
            <div className="route-alt">
              {vm.route_recommendations.map((route) => (
                <div key={route.type} className="route-alt__item">
                  <span className="route-alt__label">{route.label}</span>
                  <span className="route-alt__nodes">{route.nodes.join(' → ')}</span>
                </div>
              ))}
            </div>
          )}
        </section>

        {vm.food_cards.length > 0 && visible(60) && (
          <section>
            <SectionHead icon={vm.icons.food} title="今日美食" />
            <div className="grid-3">
              {vm.food_cards.map((card, index) => (
                <div key={`${card.name}-${index}`} className="card" {...guard('foodCard')}>
                  <Figure
                    url={card.image?.url ?? null}
                    note={card.image?.source_note ?? null}
                    fallbackIcon={vm.icons.food}
                    alt={card.name}
                  />
                  <div className="card__body">
                    <span className="card__label">{card.meal}</span>
                    <h3 className="card__name">{card.name}</h3>
                    <p className="card__desc">{text(card.description, card.description_compact)}</p>
                  </div>
                </div>
              ))}
            </div>
          </section>
        )}

        {vm.photo_spots.length > 0 && visible(50) && (
          <section>
            <SectionHead icon={vm.icons.camera} title="拍照机位" />
            <div className="grid-3">
              {vm.photo_spots.map((spot, index) => (
                <div key={`${spot.name}-${index}`} className="card" {...guard('photoSpotCard')}>
                  <Figure
                    url={spot.image?.url ?? null}
                    note={spot.image?.source_note ?? null}
                    fallbackIcon={vm.icons.camera}
                    alt={spot.name}
                  />
                  <div className="card__body">
                    <span className="card__label">{spot.time_text}</span>
                    <h3 className="card__name">{spot.name}</h3>
                  </div>
                </div>
              ))}
            </div>
          </section>
        )}

        <div className="grid-2">
          {vm.must_do.length > 0 && (
            <section>
              <SectionHead icon={vm.icons.route} title="必做体验" />
              <ul className="list">
                {vm.must_do.map((item, index) => (
                  <li key={`${item}-${index}`} className="list__item">
                    <Icon name={vm.icons.route} size={18} className="list__icon" />
                    <p className="list__text">{item}</p>
                  </li>
                ))}
              </ul>
            </section>
          )}

          {vm.budget.items.length > 0 && (
            <section>
              <SectionHead icon={vm.icons.budget} title="今日预算" />
              <div className="budget">
                <div className="budget__rows">
                  {vm.budget.items.map((item, index) => (
                    <div key={`${item.label}-${index}`} className="budget__row">
                      <span className="budget__label">{item.label}</span>
                      <span>{item.amount_text}</span>
                    </div>
                  ))}
                  <div className="budget__row budget__row--total" {...guard('budgetTotal')}>
                    <span className="budget__label">合计</span>
                    <span>{vm.budget.total_text}</span>
                  </div>
                </div>
              </div>
            </section>
          )}
        </div>

        {vm.ticket_reminders.length > 0 && (
          <section>
            <SectionHead icon={vm.icons.ticket} title="门票提醒" />
            <ul className="list">
              {vm.ticket_reminders.map((item, index) => (
                <li key={`${item.entity_name}-${index}`} className="list__item">
                  <Icon name={vm.icons.ticket} size={18} className="list__icon" />
                  <p className="list__text">
                    <span className="list__entity">{item.entity_name}</span>
                    {item.text}
                    <span className="list__badge">{item.price_text}</span>
                    {item.advance_text !== null && (
                      <span className="list__badge">{item.advance_text}</span>
                    )}
                  </p>
                </li>
              ))}
            </ul>
          </section>
        )}

        {vm.transport_tips.length > 0 && visible(30) && (
          <section>
            <SectionHead icon={vm.icons.tips} title="交通提示" />
            <ul className="list">
              {vm.transport_tips.map((tip, index) => (
                <li key={`${tip.text}-${index}`} className="list__item" {...guard('transportTip')}>
                  <Icon name={tip.icon} size={18} className="list__icon" />
                  <p className="list__text">{tip.text}</p>
                </li>
              ))}
            </ul>
          </section>
        )}

        {vm.booking_tips.length > 0 && visible(30) && (
          <section>
            <SectionHead icon={vm.icons.tips} title="预订贴士" />
            <ul className="list">
              {vm.booking_tips.map((tip, index) => (
                <li key={`${tip.text}-${index}`} className="list__item" {...guard('bookingTip')}>
                  <Icon name={vm.icons.tips} size={18} className="list__icon" />
                  <p className="list__text">
                    <span className="list__entity">{tip.category_text}</span>
                    {tip.text}
                  </p>
                </li>
              ))}
            </ul>
          </section>
        )}

        {vm.daily_summary.length > 0 && (
          <p className="summary">{text(vm.daily_summary, vm.daily_summary_compact)}</p>
        )}
      </div>

      <footer className="footer">
        <span>
          {vm.header.destination} · {vm.header.day_label} / 共 {vm.header.total_days} 天
        </span>
        <span>{vm.template_id}</span>
      </footer>
    </article>
  );
}

function Hero({ vm, compact }: { vm: TravelPosterViewModel; compact: boolean }) {
  const hero = vm.header.hero_asset;

  return (
    <header className="hero">
      {hero !== null && (
        <>
          {/* 用原生 img 而非 next/image：后者的懒加载与 srcset 会让 Playwright
              的截图时机不可控（17.2 的就绪判定依赖每个 img 的 decode() 完成），
              且导出场景不需要响应式图片 */}
          <img className="hero__image" src={hero.url} alt="" />
          <div className="hero__scrim" />
        </>
      )}

      <div className="hero__content">
        <div className="hero__meta">
          <span className="hero__day">{vm.header.day_label}</span>
          <span>
            {vm.header.destination} · 共 {vm.header.total_days} 天
          </span>
        </div>

        <h1 className="hero__title" {...guard('headerTitle')}>
          {compact ? vm.header.title_compact : vm.header.title}
        </h1>

        {vm.header.subtitle.length > 0 && (
          <p className="hero__subtitle" {...guard('headerSubtitle')}>
            {compact ? vm.header.subtitle_compact : vm.header.subtitle}
          </p>
        )}
      </div>
    </header>
  );
}

function SectionHead({ icon, title }: { icon: string; title: string }) {
  return (
    <div className="section__head">
      <Icon name={icon} size={22} className="section__icon" />
      <h2 className="section__title">{title}</h2>
    </div>
  );
}

function RouteMap({ vm }: { vm: TravelPosterViewModel }) {
  // svg_url 为 null 时渲染文字路线 —— 8.2 的 text_fallback，
  // 对应十八章「路线地图 → 简化 SVG → 纯文字路线」的最后一环
  if (vm.route_map.svg_url === null) {
    return (
      <div className="route-nodes">
        {vm.route_map.nodes.map((node, index) => (
          <span key={`${node}-${index}`} style={{ display: 'inline-flex', gap: 8 }}>
            {index > 0 && <span className="route-nodes__arrow">→</span>}
            <span className="route-nodes__item">{node}</span>
          </span>
        ))}
      </div>
    );
  }

  // 原生 img，理由同 Hero
  return <img className="route-map__svg" src={vm.route_map.svg_url} alt="路线地图" />;
}

function Figure({
  url,
  note,
  fallbackIcon,
  alt,
}: {
  url: string | null;
  note: string | null;
  fallbackIcon: string;
  alt: string;
}) {
  return (
    <div className="card__figure">
      {url === null ? (
        <div className="card__placeholder">
          <Icon name={fallbackIcon} size={40} />
        </div>
      ) : (
        // 原生 img，理由同 Hero
        <img className="card__img" src={url} alt={alt} />
      )}
      {note !== null && <span className="card__note">{note}</span>}
    </div>
  );
}
