import type { TravelPosterViewModel } from '@tps/schemas';
import { Icon } from '@/components/Icon';
import { guard } from '../../overflow-guards';
// 套件级配色与字体角色，与全览页共用（R-85 P2）
import '../tokens.css';
import './styles.css';

/**
 * blueprint_v1 —— 每日页（R-85 P2）。
 *
 * ## 与 ink_paper_v1 的布局差异
 *
 * 同一份 ViewModel，两种排布：
 *
 * | | ink_paper_v1 | blueprint_v1 |
 * | 头部 | 满幅 Hero + 压暗遮罩，标题压在图上 | **标题栏**（图纸 titleblock）：图在带边框的框里，标题与元信息在左侧的标签/值栏 |
 * | 区块 | 图标 + 标题 | **编号 + 标签**（01 / 02 …），像图纸的分区标注 |
 * | 行程 | 卡片流 | **表格行**，带网格线 |
 * | 图卡 | 3 列 | **4 列**，更密 |
 * | 预算 | 左右两列 | 标签/值 + 点线引导（drawing leader） |
 *
 * ## 三处不能自由发挥的地方
 *
 * 1. **溢出守卫的槽位与优先级**来自 `../../overflow-guards`（17.3 的契约），
 *    不是本套件能定的 —— 两套的降级顺序必须一致。
 * 2. **原生 `<img>`** 而非 `next/image`：17.2 的就绪判定依赖每个 img 的
 *    `decode()` 完成，而懒加载与 srcset 会让截图时机不可控。
 * 3. **必须实现 `[data-variant='relaxed']`**（在 styles.css 里）：
 *    17.3 第 4 轮靠它换版式，不实现则那一轮变成 no-op —— 不报错，
 *    只是降级产物占比无声上升。
 *
 * ## 模板不做数据加工
 *
 * 与 ink_paper 同一条原则：展示文案在 ViewModel 里已是最终中文，
 * 模板只负责布局。因此换套件不需要重新实现一遍文案规则。
 */

export interface BlueprintDailyProps {
  readonly viewModel: TravelPosterViewModel;
  /** 17.3 第 2 轮：启用压缩文案 */
  readonly compact?: boolean;
  /** 17.3 第 3 轮：隐藏低于此优先级的条目（`null` 表示不隐藏） */
  readonly hideBelowPriority?: number | null;
  /** 17.3 第 4 轮：宽松版式 */
  readonly variant?: 'default' | 'relaxed';
}

export function BlueprintDaily({
  viewModel: vm,
  compact = false,
  hideBelowPriority = null,
  variant = 'default',
}: BlueprintDailyProps) {
  const visible = (priority: number): boolean =>
    hideBelowPriority === null || priority >= hideBelowPriority;

  const text = (full: string, short: string): string => (compact ? short : full);

  /* 区块编号：只给实际渲染出来的区块编号，跳过的不占号 */
  let blockNo = 0;
  const nextNo = (): string => String(++blockNo).padStart(2, '0');

  return (
    <article
      className="bp-sheet"
      data-variant={variant}
      data-template={vm.template_id}
      data-page-type={vm.page_type}
      data-day={vm.day_number ?? ''}
    >
      <TitleBlock vm={vm} compact={compact} />

      <div className="bp-body">
        {vm.schedule.length > 0 && (
          <section className="bp-block">
            <BlockHead no={nextNo()} icon={vm.icons.schedule} label="行程" />
            <div className="bp-table">
              {vm.schedule.map((item, index) => (
                <div key={`${item.title}-${index}`} className="bp-row" {...guard('scheduleItem')}>
                  <div className="bp-row__period">
                    <Icon name={item.period_icon} size={16} />
                    <span>{item.period}</span>
                  </div>
                  <div className="bp-row__main">
                    <h3 className="bp-row__title">{item.title}</h3>
                    <p className="bp-row__desc">
                      {text(item.description, item.description_compact)}
                    </p>
                  </div>
                  <div className="bp-row__aside">{item.duration_text}</div>
                </div>
              ))}
            </div>
          </section>
        )}

        <section className="bp-block">
          <BlockHead no={nextNo()} icon={vm.icons.map} label="路线" />
          <RouteMap vm={vm} />
          {vm.route_recommendations.length > 0 && (
            <div className="bp-table bp-table--tight">
              {vm.route_recommendations.map((route) => (
                <div key={route.type} className="bp-row bp-row--pair">
                  <span className="bp-key">{route.label}</span>
                  <span className="bp-val">{route.nodes.join(' → ')}</span>
                </div>
              ))}
            </div>
          )}
        </section>

        {vm.food_cards.length > 0 && visible(60) && (
          <section className="bp-block">
            <BlockHead no={nextNo()} icon={vm.icons.food} label="美食" />
            <div className="bp-grid-4">
              {vm.food_cards.map((card, index) => (
                <div key={`${card.name}-${index}`} className="bp-plate" {...guard('foodCard')}>
                  <Plate
                    url={card.image?.url ?? null}
                    note={card.image?.source_note ?? null}
                    fallbackIcon={vm.icons.food}
                    alt={card.name}
                  />
                  <div className="bp-plate__body">
                    <span className="bp-plate__tag">{card.meal}</span>
                    <h3 className="bp-plate__name">{card.name}</h3>
                    <p className="bp-plate__desc">
                      {text(card.description, card.description_compact)}
                    </p>
                  </div>
                </div>
              ))}
            </div>
          </section>
        )}

        {vm.photo_spots.length > 0 && visible(50) && (
          <section className="bp-block">
            <BlockHead no={nextNo()} icon={vm.icons.camera} label="机位" />
            <div className="bp-grid-4">
              {vm.photo_spots.map((spot, index) => (
                <div key={`${spot.name}-${index}`} className="bp-plate" {...guard('photoSpotCard')}>
                  <Plate
                    url={spot.image?.url ?? null}
                    note={spot.image?.source_note ?? null}
                    fallbackIcon={vm.icons.camera}
                    alt={spot.name}
                  />
                  <div className="bp-plate__body">
                    <span className="bp-plate__tag">{spot.time_text}</span>
                    <h3 className="bp-plate__name">{spot.name}</h3>
                  </div>
                </div>
              ))}
            </div>
          </section>
        )}

        <div className="bp-cols">
          {vm.must_do.length > 0 && (
            <section className="bp-block">
              <BlockHead no={nextNo()} icon={vm.icons.route} label="必做" />
              <ul className="bp-lines">
                {vm.must_do.map((item, index) => (
                  <li key={`${item}-${index}`} className="bp-line">
                    <span className="bp-line__mark" aria-hidden="true" />
                    <p className="bp-line__text">{item}</p>
                  </li>
                ))}
              </ul>
            </section>
          )}

          {vm.budget.items.length > 0 && (
            <section className="bp-block">
              <BlockHead no={nextNo()} icon={vm.icons.budget} label="预算" />
              <div className="bp-table bp-table--tight">
                {vm.budget.items.map((item, index) => (
                  <div key={`${item.label}-${index}`} className="bp-row bp-row--lead">
                    <span className="bp-key">{item.label}</span>
                    <span className="bp-num">{item.amount_text}</span>
                  </div>
                ))}
                <div className="bp-row bp-row--lead bp-row--total" {...guard('budgetTotal')}>
                  <span className="bp-key">合计</span>
                  <span className="bp-num">{vm.budget.total_text}</span>
                </div>
              </div>
            </section>
          )}
        </div>

        {vm.ticket_reminders.length > 0 && (
          <section className="bp-block">
            <BlockHead no={nextNo()} icon={vm.icons.ticket} label="门票" />
            <ul className="bp-lines">
              {vm.ticket_reminders.map((item, index) => (
                <li key={`${item.entity_name}-${index}`} className="bp-line">
                  <span className="bp-line__mark" aria-hidden="true" />
                  <p className="bp-line__text">
                    <span className="bp-line__entity">{item.entity_name}</span>
                    {item.text}
                    <span className="bp-chip">{item.price_text}</span>
                    {item.advance_text !== null && (
                      <span className="bp-chip bp-chip--warm">{item.advance_text}</span>
                    )}
                  </p>
                </li>
              ))}
            </ul>
          </section>
        )}

        {vm.transport_tips.length > 0 && visible(30) && (
          <section className="bp-block">
            <BlockHead no={nextNo()} icon={vm.icons.tips} label="交通" />
            <ul className="bp-lines">
              {vm.transport_tips.map((tip, index) => (
                <li key={`${tip.text}-${index}`} className="bp-line" {...guard('transportTip')}>
                  <Icon name={tip.icon} size={16} className="bp-line__icon" />
                  <p className="bp-line__text">{tip.text}</p>
                </li>
              ))}
            </ul>
          </section>
        )}

        {vm.booking_tips.length > 0 && visible(30) && (
          <section className="bp-block">
            <BlockHead no={nextNo()} icon={vm.icons.tips} label="预订" />
            <ul className="bp-lines">
              {vm.booking_tips.map((tip, index) => (
                <li key={`${tip.text}-${index}`} className="bp-line" {...guard('bookingTip')}>
                  <span className="bp-line__mark" aria-hidden="true" />
                  <p className="bp-line__text">
                    <span className="bp-line__entity">{tip.category_text}</span>
                    {tip.text}
                  </p>
                </li>
              ))}
            </ul>
          </section>
        )}

        {vm.daily_summary.length > 0 && (
          <p className="bp-note">{text(vm.daily_summary, vm.daily_summary_compact)}</p>
        )}
      </div>

      {/* 图纸的修订栏：把元信息压在底边一条细带里 */}
      <footer className="bp-strip">
        <span className="bp-strip__cell">{vm.header.destination}</span>
        <span className="bp-strip__cell">
          {vm.header.day_label} / 共 {vm.header.total_days} 天
        </span>
        <span className="bp-strip__cell bp-strip__cell--id">{vm.template_id}</span>
      </footer>
    </article>
  );
}

/**
 * 图纸标题栏。
 *
 * 与 ink_paper 的 Hero 不同：图片不满幅、不压遮罩、标题不压在图上 ——
 * 图在右侧的框里，标题与元信息在左侧成为标签/值对。
 * 这样标题永远在纯色底上，长标题不会因为图的明暗而读不清。
 */
function TitleBlock({ vm, compact }: { vm: TravelPosterViewModel; compact: boolean }) {
  const hero = vm.header.hero_asset;

  return (
    <header className="bp-title">
      <div className="bp-title__text">
        <div className="bp-title__meta">
          <span className="bp-key">日程</span>
          <span className="bp-val">{vm.header.day_label}</span>
          <span className="bp-key">目的地</span>
          <span className="bp-val">{vm.header.destination}</span>
          <span className="bp-key">总天数</span>
          <span className="bp-val">{vm.header.total_days}</span>
        </div>

        <h1 className="bp-title__h1" {...guard('headerTitle')}>
          {compact ? vm.header.title_compact : vm.header.title}
        </h1>

        {vm.header.subtitle.length > 0 && (
          <p className="bp-title__sub" {...guard('headerSubtitle')}>
            {compact ? vm.header.subtitle_compact : vm.header.subtitle}
          </p>
        )}
      </div>

      {hero !== null && (
        <figure className="bp-title__frame">
          {/* 原生 img：理由见文件头第 2 条 */}
          <img className="bp-title__img" src={hero.url} alt="" />
        </figure>
      )}
    </header>
  );
}

function BlockHead({ no, icon, label }: { no: string; icon: string; label: string }) {
  return (
    <div className="bp-block__head">
      <span className="bp-block__no">{no}</span>
      <Icon name={icon} size={18} className="bp-block__icon" />
      <h2 className="bp-block__label">{label}</h2>
      <span className="bp-block__rule" aria-hidden="true" />
    </div>
  );
}

function RouteMap({ vm }: { vm: TravelPosterViewModel }) {
  // svg_url 为 null 时渲染文字路线 —— 8.2 的 text_fallback
  if (vm.route_map.svg_url === null) {
    return (
      <div className="bp-nodes">
        {vm.route_map.nodes.map((node, index) => (
          <span key={`${node}-${index}`} className="bp-nodes__group">
            {index > 0 && <span className="bp-nodes__arrow">→</span>}
            <span className="bp-nodes__item">{node}</span>
          </span>
        ))}
      </div>
    );
  }

  // 原生 img，理由同上
  return (
    <figure className="bp-map">
      <img className="bp-map__svg" src={vm.route_map.svg_url} alt="路线地图" />
    </figure>
  );
}

function Plate({
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
    <div className="bp-plate__figure">
      {url === null ? (
        <div className="bp-plate__blank">
          <Icon name={fallbackIcon} size={32} />
        </div>
      ) : (
        // 原生 img，理由同上
        <img className="bp-plate__img" src={url} alt={alt} />
      )}
      {note !== null && <span className="bp-plate__note">{note}</span>}
    </div>
  );
}
