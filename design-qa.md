# Planner redesign QA

Final result: **passed**

## Scope and reference

- Reference: `preview/planner.html`, especially “同行人员” and “旅行预算”.
- Implementation: planner steps 01–05 and the global right rail.
- Desktop viewport: 1440 × 1000.
- Mobile viewport: 390 × 844.
- Side-by-side evidence: `out/ui-audit/design-comparison.png`.

## Visual comparison

- Layout and spacing: personnel rows, counter placement, budget tier grid, selected-card treatment, summary surface, radii and spacing follow the reference hierarchy.
- Typography and colors: existing planner tokens and self-hosted fonts are retained. Preference is blue, required is red, and exclusion is dark ink with a line-through.
- Icons: the implementation uses the project icon library; no remote image or emoji dependency was added.
- Required product differences:
  - Personnel expands the reference's three groups to five: infant, child, teen, adult and senior.
  - Budget custom sliders are shown after choosing “自定义预算”, so a visible editor always maps to an active backend budget mode.
  - State words are omitted from multi-state button labels as requested; accessible state and next action remain in `aria-label`.

## Interaction and accessibility checks

- Destination plus-card adds a new ordered destination row.
- Start/end dates and daily start/end times preserve the first value while the second value is selected.
- Five personnel counters update both `travelers.count` and `travelers.profiles`.
- Budget tier selection, custom range sliders, basis selection and currency selection update the existing backend fields.
- Four-state buttons cycle `NONE → PREFER → REQUIRE → EXCLUDE → NONE` on desktop and mobile.
- The right rail is now task-oriented planning progress rather than a duplicate profile summary.
- Keyboard-readable names, `aria-pressed`, range outputs, focus states and mobile tap targets remain present.
- Mobile step drawer, progress drawer and outside-click dismissal pass.

## Verification evidence

- Web unit/component tests: 323 passed.
- TypeScript: passed.
- ESLint for changed planner components: passed.
- Next.js production build: passed.
- Docker image build and local `tps-web` recreation: passed.
- Playwright against `http://localhost:8080`: 9 passed, 0 failed.
- The unauthenticated session endpoint returns the expected 401 in the complete stack; no application exception was observed.

---

## 旅行轮廓页视觉与交互验收

## 验收对象

- 参考图：`D:\Doc\Travel_Idea\design\page-1.png`
- 本地页面：`http://localhost:3002/`
- 验收日期：2026-09-04
- 桌面视口：1600 × 2200
- 手机视口：390 × 844

## 视觉对照

已将参考图和交互填充后的实现截图放入同一张对照图检查，结果通过。

- 对照图：`out/qa/outline-comparison.png`
- 桌面实现：`out/qa/travel-outline.png`
- 手机实现：`out/qa/travel-outline-mobile.png`

通过项：

- 白色圆角主卡、浅灰蓝画布、轻阴影和蓝色主标题与参考稿一致。
- 页码、说明文字、分区标题、虚线分隔与底部主按钮形成同一视觉层级。
- 日期使用两列布局；窄屏自动改为单列。
- 目的地使用编号行、地点图标、国家/地区、排序操作和虚线添加入口。
- 单选与多选沿用系统蓝色选中态，必填徽标沿用全站语义色。
- 未添加后端契约不存在的“逐目的地抵达日期、停留天数、抵达方式”字段，避免保存假数据。

## 交互验收

自动化点击并断言以下路径：

1. 填写出发地与国家/地区。
2. 选择出发日期和返回日期，确认输入值正常回显。
3. 选择目的地状态。
4. 连续添加两个目的地并填写国家/地区。
5. 将第二个目的地上移，确认顺序由“上海、杭州”变成“杭州、上海”。
6. 选择日期弹性、旅行目的和三项旅行目标。
7. 选择“暂无不可变预订”。
8. 在 390px 宽度检查页面横向溢出，结果为 `false`。

最终结果：通过。
