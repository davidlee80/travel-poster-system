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
