'use client';

import type { AgeBand, TravelerProfile } from '@tps/schemas';

import { Icon } from '@/components/Icon';
import { readAnswer, type PlannerAction, type PlannerState } from '@/lib/planner/state';

const GROUPS = [
  { band: 'INFANT', label: '婴幼儿', range: '0～2 岁', icon: 'period-morning' },
  { band: 'CHILD', label: '儿童', range: '3～11 岁', icon: 'camera' },
  { band: 'TEEN', label: '少年', range: '12～17 岁', icon: 'transport-bike' },
  { band: 'ADULT', label: '成人', range: '18～64 岁', icon: 'transport-walk' },
  { band: 'SENIOR', label: '长者', range: '65 岁及以上', icon: 'tips' },
] as const satisfies readonly {
  readonly band: AgeBand;
  readonly label: string;
  readonly range: string;
  readonly icon: string;
}[];

const MAX_TRAVELERS = 20;

export function TravelersControl({
  state,
  dispatch,
}: {
  readonly state: PlannerState;
  readonly dispatch: (action: PlannerAction) => void;
}): React.ReactElement {
  const profiles = travelerProfiles(readAnswer(state.answers, 'travelers.profiles'));
  const fallbackCount = readAnswer(state.answers, 'travelers.count');
  const counts = Object.fromEntries(
    GROUPS.map(({ band }) => [
      band,
      profiles.filter((profile) => profile.age_band === band).length,
    ]),
  ) as Record<AgeBand, number>;

  /* 兼容只存了旧版人数、还没有逐人画像的草稿：先按成人显示，第一次加减后即完成迁移。 */
  if (profiles.length === 0 && typeof fallbackCount === 'number') counts.ADULT = fallbackCount;

  const total = Object.values(counts).reduce((sum, count) => sum + count, 0);

  const write = (band: AgeBand, delta: number): void => {
    const nextCounts = { ...counts };
    nextCounts[band] = Math.max(0, nextCounts[band] + delta);
    const nextProfiles = profilesFromCounts(nextCounts);
    const nextTotal = nextProfiles.length;

    dispatch({
      type: 'answer',
      fieldId: 'PV2-02-001',
      patch: { travelers: { count: nextTotal === 0 ? undefined : nextTotal } },
    });
    dispatch({
      type: 'answer',
      fieldId: 'PV2-02-002',
      patch: { travelers: { profiles: [...nextProfiles] } },
    });
  };

  return (
    <div className="planner-traveler-groups" aria-label="旅行人员分类计数">
      <div className="planner-traveler-groups__summary" aria-live="polite">
        <div>
          <span>本次旅行人员</span>
          <strong>{total === 0 ? '请添加人员' : `共 ${total} 人`}</strong>
        </div>
        <p>{summaryText(counts)}</p>
      </div>

      <div className="planner-travelers">
        {GROUPS.map((group) => {
          const count = counts[group.band];
          return (
            <div className="planner-traveler" key={group.band}>
              <div className="planner-traveler__info">
                <span
                  className={`planner-traveler__icon planner-traveler__icon--${group.band.toLowerCase()}`}
                  aria-hidden="true"
                >
                  <Icon name={group.icon} size={21} />
                </span>
                <span>
                  <strong>{group.label}</strong>
                  <small>{group.range}</small>
                </span>
              </div>
              <div className="planner-counter">
                <button
                  type="button"
                  aria-label={`减少${group.label}`}
                  disabled={count === 0}
                  onClick={() => write(group.band, -1)}
                >
                  −
                </button>
                <output aria-label={`${group.label}人数`}>{count}</output>
                <button
                  type="button"
                  aria-label={`增加${group.label}`}
                  disabled={total >= MAX_TRAVELERS}
                  onClick={() => write(group.band, 1)}
                >
                  ＋
                </button>
              </div>
            </div>
          );
        })}
      </div>
      <p className="planner-hint">按年龄段加减即可；系统会自动汇总人数并生成对应的旅行人员信息。</p>
    </div>
  );
}

function travelerProfiles(value: unknown): readonly TravelerProfile[] {
  if (!Array.isArray(value)) return [];
  return value.filter((entry): entry is TravelerProfile => {
    if (typeof entry !== 'object' || entry === null) return false;
    const band = (entry as { age_band?: unknown }).age_band;
    return GROUPS.some((group) => group.band === band);
  });
}

function profilesFromCounts(counts: Readonly<Record<AgeBand, number>>): readonly TravelerProfile[] {
  const profiles: TravelerProfile[] = [];
  /* 成人优先只是为了稳定确定“SELF”；界面展示顺序仍按 GROUPS，不受数组顺序影响。 */
  const profileOrder: readonly AgeBand[] = ['ADULT', 'SENIOR', 'TEEN', 'CHILD', 'INFANT'];
  for (const band of profileOrder) {
    for (let index = 0; index < counts[band]; index += 1) {
      profiles.push({
        age_band: band,
        // 人数控件只知道年龄段，不能把第二位成人猜成伴侣、把长者
        // 猜成父母。首位代表用户本人，其余关系保持“其他/未细分”。
        relation: profiles.length === 0 ? 'SELF' : 'OTHER',
      });
    }
  }
  return profiles;
}

function summaryText(counts: Readonly<Record<AgeBand, number>>): string {
  const parts = GROUPS.flatMap((group) =>
    counts[group.band] === 0 ? [] : [`${group.label} ${counts[group.band]} 人`],
  );
  return parts.length === 0 ? '包括你自己在内，选择这次会出发的所有人。' : parts.join(' · ');
}
