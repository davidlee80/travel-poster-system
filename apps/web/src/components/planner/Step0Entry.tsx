'use client';

import { ENTRY_ROUTE_LABEL } from '@/lib/planner/entry-routes';
import type { EntryRoute } from '@/lib/planner/state';

/**
 * 第 0 步（入口页）的四张路线卡。
 *
 * 设计稿：`E:/Doc/Prompt/AI_Travel_Idea/design/new/00.html`
 * 四张卡分别对应一种「旅行准备状态」，选中后影响第 1 步展示哪些区块
 * （见 `lib/planner/entry-routes.ts`）。
 *
 * ## 为什么不复用 StepPage 的字段渲染
 *
 * 第 0 步没有契约字段（`STEP_SECTIONS['00']` 为空数组），它的全部内容
 * 就是这四张卡。塞进通用字段渲染器会让「一张卡 = 一个假字段」，
 * 而那会把 UI 状态污染进 76 字段的契约表里。
 */

export interface Step0EntryProps {
  readonly selected: EntryRoute | null;
  readonly onSelect: (route: EntryRoute) => void;
}

interface EntryCard {
  readonly route: EntryRoute;
  readonly caption: string;
  readonly tags: readonly string[];
  readonly hint: string;
  readonly art: 'explore' | 'destination' | 'time' | 'plan';
}

const CARDS: readonly EntryCard[] = [
  {
    route: 'explore',
    caption: 'FIND YOUR INSPIRATION',
    tags: ['目的地未定', '时间未定'],
    hint: '从喜欢的体验，找到旅行方向',
    art: 'explore',
  },
  {
    route: 'destination',
    caption: 'MAKE THE MOST OF YOUR DAYS',
    tags: ['目的地未定', '时间已定 ✓'],
    hint: '根据假期、预算，比较目的地',
    art: 'destination',
  },
  {
    route: 'time',
    caption: 'A PLACE ON YOUR WISHLIST',
    tags: ['目的地已定 ✓', '时间未定'],
    hint: '比较出行窗口，让心愿更近一步',
    art: 'time',
  },
  {
    route: 'plan',
    caption: 'LET’S PUT IT ALL TOGETHER',
    tags: ['目的地已定 ✓', '时间已定 ✓'],
    hint: '整理交通、住宿，生成行程草案',
    art: 'plan',
  },
];

export function Step0Entry({ selected, onSelect }: Step0EntryProps): React.ReactElement {
  return (
    <div className="planner-step0">
      <p className="planner-step0__eyebrow">EVERY JOURNEY STARTS SOMEWHERE</p>
      <div className="planner-step0__grid" role="radiogroup" aria-label="选择当前的旅行准备状态">
        {CARDS.map((card) => {
          const active = selected === card.route;
          return (
            <button
              key={card.route}
              type="button"
              role="radio"
              aria-checked={active}
              className={`planner-step0__card planner-step0__card--${card.art}${
                active ? ' planner-step0__card--active' : ''
              }`}
              onClick={() => onSelect(card.route)}
            >
              <span className="planner-step0__mark" aria-hidden="true">
                {active ? '✓' : ''}
              </span>
              <span className={`planner-step0__art planner-step0__art--${card.art}`} aria-hidden="true">
                <span className="planner-step0__art-caption">{card.caption}</span>
                <Step0Art kind={card.art} />
              </span>
              <span className="planner-step0__body">
                <span className="planner-step0__tags" aria-hidden="true">
                  {card.tags.map((tag) => (
                    <span
                      key={tag}
                      className={`planner-step0__tag${tag.endsWith('✓') ? ' planner-step0__tag--confirmed' : ''}`}
                    >
                      {tag}
                    </span>
                  ))}
                </span>
                <span className="planner-step0__title">{ENTRY_ROUTE_LABEL[card.route]}</span>
                <span className="planner-step0__desc">{card.hint}</span>
                <span className="planner-step0__arrow" aria-hidden="true">
                  ↗
                </span>
              </span>
            </button>
          );
        })}
      </div>
      <p className="planner-step0__hint">
        这只是起点，不是限制，后面随时可以调整。
      </p>
    </div>
  );
}

/**
 * 四张卡的插画，逐字取自设计稿 `00.html` 的内联 SVG。
 *
 * `aria-hidden`：它们是纯装饰，选中语义由按钮的 `aria-checked` 表达，
 * 屏读用户不需要「紫圆圈上一个虚线椭圆」这种信息。
 */
function Step0Art({ kind }: { readonly kind: EntryCard['art'] }): React.ReactElement {
  switch (kind) {
    case 'explore':
      return (
        <svg viewBox="0 0 460 158" fill="none">
          <circle cx="360" cy="45" r="72" fill="#E0DFF2" />
          <circle cx="88" cy="165" r="84" fill="#DFE4F3" />
          <ellipse
            cx="259"
            cy="94"
            rx="108"
            ry="38"
            transform="rotate(-15 259 94)"
            stroke="#A5A0C5"
            strokeDasharray="4 7"
          />
          <circle cx="265" cy="89" r="39" fill="#B6B4DA" />
          <path d="M231 76C248 61 273 61 292 74" stroke="#DCDCF0" strokeWidth="13" />
          <path d="M231 99C247 91 271 99 292 94" stroke="#9395BF" strokeWidth="12" />
          <ellipse
            cx="265"
            cy="89"
            rx="63"
            ry="13"
            transform="rotate(-24 265 89)"
            stroke="#FDFCF8"
            strokeWidth="7"
          />
          <path d="M128 59L149 53L141 72L137 62L128 59Z" fill="#8187B3" />
          <path d="M126 85L112 103" stroke="#B6B4D0" strokeLinecap="round" />
          <path d="M343 96V108M337 102H349" stroke="#8681AC" strokeWidth="2" />
          <path d="M194 40V48M190 44H198" stroke="#ACA5C8" strokeWidth="2" />
          <circle cx="181" cy="126" r="3" fill="#A4ABC8" />
          <circle cx="331" cy="51" r="3" fill="#FFFDF9" />
          <circle cx="385" cy="119" r="2" fill="#B6B4D0" />
        </svg>
      );
    case 'destination':
      return (
        <svg viewBox="0 0 460 158" fill="none">
          <circle cx="325" cy="84" r="67" fill="#F7E1B7" />
          <path d="M55 128H408" stroke="#E9D7B7" strokeDasharray="4 7" />
          <g transform="rotate(-9 245 92)">
            <rect x="172" y="42" width="140" height="109" rx="12" fill="#DBC7A4" opacity=".35" />
            <rect x="167" y="36" width="140" height="109" rx="12" fill="#FFFCF4" />
            <path
              d="M167 48C167 41 172 36 179 36H295C302 36 307 41 307 48V65H167V48Z"
              fill="#DCA363"
            />
            <path d="M195 30V46M278 30V46" stroke="#866D50" strokeWidth="5" strokeLinecap="round" />
            <g fill="#E9E0CE">
              <rect x="184" y="79" width="19" height="16" rx="4" />
              <rect x="213" y="79" width="19" height="16" rx="4" />
              <rect x="242" y="79" width="19" height="16" rx="4" />
              <rect x="271" y="79" width="19" height="16" rx="4" />
              <rect x="184" y="106" width="19" height="16" rx="4" />
              <rect x="213" y="106" width="19" height="16" rx="4" />
            </g>
            <rect x="239" y="102" width="53" height="24" rx="7" fill="#EDD09B" />
            <path
              d="M253 114L260 120L276 108"
              stroke="#946F38"
              strokeWidth="3"
              strokeLinecap="round"
              strokeLinejoin="round"
            />
          </g>
          <g transform="rotate(12 336 108)">
            <rect x="309" y="89" width="61" height="38" rx="6" fill="#7C977A" />
            <path d="M328 103H351M328 113H343" stroke="#F1F1DB" strokeWidth="2" strokeLinecap="round" />
            <path d="M320 90V126" stroke="#B2C3A0" strokeDasharray="3 4" />
          </g>
          <path
            d="M118 75L123 63L128 75L140 80L128 85L123 97L118 85L106 80L118 75Z"
            fill="#DCB773"
          />
        </svg>
      );
    case 'time':
      return (
        <svg viewBox="0 0 460 158" fill="none">
          <circle cx="107" cy="155" r="87" fill="#D9E5D7" />
          <path d="M317 158C305 116 348 66 414 78" stroke="#CEDDCA" strokeWidth="35" />
          <g transform="rotate(-6 244 96)">
            <rect x="152" y="39" width="186" height="115" rx="5" fill="#829B7D" opacity=".16" />
            <rect x="147" y="33" width="186" height="115" rx="5" fill="#FFFEF8" />
            <rect x="157" y="43" width="166" height="82" rx="2" fill="#E0EBDD" />
            <circle cx="285" cy="64" r="12" fill="#F0DA9F" />
            <path d="M157 108L200 67L249 125H157V108Z" fill="#9CB497" />
            <path d="M199 125L258 73L323 125H199Z" fill="#759578" />
            <path d="M242 88L258 73L275 88L259 84L251 90L242 88Z" fill="#F1F3E8" />
            <path d="M157 125C203 110 258 145 323 116V125H157Z" fill="#BBCDB0" />
            <path
              d="M167 136H228M280 136H310"
              stroke="#D6DBCB"
              strokeWidth="3"
              strokeLinecap="round"
            />
          </g>
          <path
            d="M349 58C349 45 339 36 327 36C315 36 305 45 305 58C305 73 327 91 327 91C327 91 349 73 349 58Z"
            fill="#527C60"
          />
          <circle cx="327" cy="57" r="7" fill="#F1F3E5" />
          <path d="M117 96C126 101 130 112 126 124C113 118 109 107 117 96Z" fill="#8DA98B" />
          <path d="M126 123L134 138" stroke="#8DA98B" strokeWidth="2" />
        </svg>
      );
    case 'plan':
      return (
        <svg viewBox="0 0 460 158" fill="none">
          <circle cx="334" cy="123" r="70" fill="#F3D5C8" />
          <g transform="rotate(-7 242 96)">
            <path d="M133 49L197 37L259 51L324 39V137L259 149L197 135L133 148V49Z" fill="#FFFBF3" />
            <path d="M197 37V135M259 51V149" stroke="#E7DCCB" strokeWidth="2" />
            <path d="M142 80L189 69L239 86L311 71" stroke="#EEE9DB" strokeWidth="10" />
            <path d="M165 49L177 139M288 48L277 142" stroke="#EEE9DB" strokeWidth="7" />
            <path
              d="M152 125C160 91 201 127 223 95C245 63 270 112 299 77"
              stroke="#C7866E"
              strokeWidth="3"
              strokeDasharray="5 6"
              strokeLinecap="round"
            />
            <circle cx="152" cy="125" r="7" fill="#E7B198" />
            <circle cx="223" cy="95" r="7" fill="#E7B198" />
            <circle cx="299" cy="77" r="8" fill="#B8735B" />
            <path d="M295 77L298 80L303 74" stroke="white" strokeWidth="2" strokeLinecap="round" />
          </g>
          <g transform="rotate(9 342 108)">
            <rect x="322" y="82" width="49" height="57" rx="9" fill="#83A193" />
            <path d="M336 81V75C336 70 357 70 357 75V81" stroke="#5B7D6C" strokeWidth="3" />
            <path d="M334 94V126M359 94V126" stroke="#B8CBBE" strokeWidth="3" strokeLinecap="round" />
            <circle cx="334" cy="142" r="3" fill="#5B7D6C" />
            <circle cx="359" cy="142" r="3" fill="#5B7D6C" />
          </g>
          <path d="M112 71V83M106 77H118" stroke="#C69A83" strokeWidth="2" />
        </svg>
      );
  }
}
