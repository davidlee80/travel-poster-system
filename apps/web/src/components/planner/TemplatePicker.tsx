'use client';

import type { TemplateId } from '@tps/schemas';

import type { PlannerAction } from '@/lib/planner/state';
import { useTemplateOptions } from './PlannerConfigProvider';

/**
 * 输出样式选择器（R-85 P3，第 9 步）。
 *
 * ## 为什么在第 9 步而不是某一步问卷里
 *
 * 样式不是问卷问题 —— 它不在 76 字段里，在请求里也不走 `planner_profile`
 * 而走 `output_preferences`。第 9 步的规范定位是「不重复问卷，而是确认理解、
 * 集中解决待确认项、完成授权并进入生成」，选样式正好属于「进入生成前的
 * 最后一个选择」。
 *
 * ## 为什么不走 `slots`
 *
 * 第 9 步已有一套 `slots` 机制按 field ID 注入元字段（复核面板、阻塞项清单）。
 * 但那个机制的键是 `PlannerFieldId`，而样式**没有 field ID**（它不是字段）。
 * 硬造一个假 field ID 会让它出现在完成度、blocker、Dev Mode 这三处遍历里 ——
 * 于是「没选样式」会被算成一个未填字段，而它本来就有默认值。
 *
 * ## 选项为空时整个区块不渲染
 *
 * 空的三种来源：配置还没拉到（首帧）、配置里没有这一组、配置里的行全都
 * 缺示例图或不是已知套件。三种都不该回退到硬编码列表 ——
 * 详见 `useTemplateOptions` 的注释。用户什么也看不到，拿默认套件，
 * 与加这个功能之前一致。
 *
 * ## 「用默认」是一个显式选项
 *
 * 不把第一张卡片预选中。`null` 与「选了默认那一套」在载荷上不同：
 * 前者不发 `output_preferences`（后端补默认），后者显式发。
 * 两者今天等价，但默认套件将来会换 —— 那时「我当初没选」应该跟着换，
 * 而「我当初选了水墨纸本」不应该。
 */

export interface TemplatePickerProps {
  readonly selected: TemplateId | null;
  readonly dispatch: (action: PlannerAction) => void;
}

export function TemplatePicker({ selected, dispatch }: TemplatePickerProps) {
  const options = useTemplateOptions();
  if (options.length === 0) return null;

  return (
    <section className="planner-template-picker" aria-labelledby="planner-template-picker-title">
      <h3 className="planner-template-picker__title" id="planner-template-picker-title">
        输出样式
      </h3>
      <p className="planner-template-picker__hint">
        每一套样式都包含全览页与每日页。不选则使用默认样式。
      </p>

      <ul className="planner-template-picker__list">
        {options.map((option) => {
          const active = option.templateId === selected;
          return (
            <li key={option.templateId}>
              <button
                type="button"
                className="planner-template-card"
                /*
                 * `aria-pressed` 而不是 `aria-selected`：后者要求父元素是
                 * listbox/grid 等特定角色，而这里是一组独立的切换按钮。
                 */
                aria-pressed={active}
                data-active={active}
                onClick={() =>
                  dispatch({
                    type: 'setTemplate',
                    /* 再点一次取消选择，回到「用默认」 */
                    templateId: active ? null : option.templateId,
                  })
                }
              >
                {/*
                  原生 `<img>` 而不是 `next/image`：示例图是 public 下的静态文件，
                  尺寸固定且已压过（约 27KB），过一遍优化器只增加构建期开销。
                  `loading="lazy"` 也不要 —— 这个区块在第 9 步首屏内。
                */}
                <img
                  className="planner-template-card__image"
                  src={option.previewImage}
                  alt={`${option.label}样式示例`}
                  width={200}
                  height={280}
                />
                <span className="planner-template-card__label">{option.label}</span>
              </button>
            </li>
          );
        })}
      </ul>
    </section>
  );
}
