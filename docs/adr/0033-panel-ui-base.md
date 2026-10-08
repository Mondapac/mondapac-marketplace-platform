# ADR-0033: Panel UI Base (D1)

**Status:** Proposed — 2026-10-08. For Ali (cto) and Mohammad (software-architect) to rule on;
Hassan (security-tester) reviewed the SVG icon and install-policy points (decisions 7 and 9).
**Relates to:** ADR-0017 (Figma is the source of truth), ADR-0014 (toolchain baseline),
ADR-0034 (app topology), `docs/design/frontend-kickoff.md` (D1, section 15),
`docs/design/tokens/` (exported tokens), CLAUDE.md rule 12.

## Context
The admin and seller panels need a component base that (a) renders the exported Figma tokens
without a second source of truth, (b) gives keyboard and screen-reader behaviour (WCAG 2.2 AA,
kickoff section 11) that we do not hand-write for menus, dialogs, tabs and tooltips, and (c) lets
us own the look, because the design (ADR-0017) is ours and a styled kit would fight it.
CLAUDE.md names Next.js and TypeScript as the frontend default. A spike on 2026-10-08 built a
Next.js 16.4 app with React 19.3, Tailwind 4.3 and `@base-ui/react` 1.2 on `tokens.css`
unchanged, with `dir="rtl"` and logical utilities: the production build passes and the
generated CSS references the `--mp-*` variables, not copies of their values. It proves a build
only; the install policy check (`pnpm-workspace.yaml`, no install scripts for Next's `sharp` or
Tailwind's native binary) is part of the scaffold PR and blocks it if it fails.

## Decision
1. **Framework:** Next.js (App Router) on React 19 and TypeScript, as the CLAUDE.md default.
   Panels use server rendering for the session check and client components for interaction.
2. **Styling:** Tailwind CSS v4. `tokens.css` is imported as is and never edited by hand.
   A small `@theme inline` file maps Tailwind theme names to `var(--mp-*)`. Tailwind's default
   palette, spacing and radius scales are disabled (`--color-*: initial`), so a class that
   is not a token has no colour. The lint rule is the control (Tailwind arbitrary values still
   compile): it rejects hex, `rgb()` and arbitrary-value colour classes in app and `packages/ui` code (Bagher checks it in release review).
   Dark mode follows the exported `[data-theme="dark"]` block; switching it on is a product
   decision (D5), not part of this ADR.
3. **Headless behaviour:** Base UI (`@base-ui/react`). Radix is not chosen: Base UI is actively
   developed, is also headless and unstyled, and covers the primitives we need
   (Dialog, Menu, Tabs, Tooltip, Select, Checkbox, Switch, Field). A primitive that Base UI
   lacks is built in `packages/ui` with the same API shape, never pulled from a second kit. Pin an exact version. Exit
   trigger: if Base UI is abandoned or has an unfixed accessibility defect we cannot work around,
   we swap it inside `packages/ui` (the only importer). The F1 PR smoke-checks Dialog, Menu and
   Select focus and placement under RTL, and lists which kickoff components (Combobox, Popover,
   Toast, Radio, Command palette) need a build of our own.
4. **Our components:** `packages/ui` holds components in the shadcn style, copied and owned
   (no shadcn CLI dependency, no generated registry). Each wraps one Base UI primitive or plain
   HTML, takes only token-backed variants, and is named as in the Figma library (kickoff section 4).
   A component is added only after it exists in Figma (CLAUDE.md rule 12).
5. **Tables:** TanStack Table for the headless model behind `DataTable`; the markup, sticky
   header, density and bulk-action bar are ours.
6. **Forms and validation:** React Hook Form with Zod. Schemas are generated from the OpenAPI
   document once ADR-0034 decision 7 lands; before that they are hand-written, advisory, and
   covered by a contract test. The server answer stays the authority and its reason codes map
   to copy (`docs/modules/identity/ux.md`). Another form or validation library needs a new entry here.
7. **Icons:** the icon set already in Figma, exported as SVG components into `packages/ui` (sanitised at export, never injected as raw markup).
8. **Tests:** Vitest with Testing Library for components, Playwright for a flow per slice
   (it also takes the milestone screenshots). Every component has a states page
   (default, hover, focus, disabled, loading, empty, error); the tool for it (Storybook or a
   plain Next.js route) is chosen in the F1 PR with its own small ADR note, not now.
9. **Dependencies:** every new dependency goes through its own small PR (shared lockfile),
   exact versions, no install scripts (`pnpm-workspace.yaml` policy stays).
10. **Text direction and language:** components use CSS logical properties (`ps-*`, `ms-*`,
    `start`/`end`) only, so a right-to-left Market works without rework. Strings never
    live inline. One i18n library (next-intl, ICU plurals; Market locale maps to `lang` and `dir`)
    serves all apps; `packages/ui` ships its own catalogue (aria labels, "Close") that each app
    can override. English is the first catalogue. A lint rule also bans physical utilities
    (`left-*`, `right-*`, `pl-*`, `pr-*`, `text-left`, `text-right`).

## Consequences
- Colours and spacing cannot drift from Figma; a token change is a re-export, not a code hunt.
- We own the component code and its accessibility regressions; Base UI removes the hardest part.
- Base UI is younger than Radix; if it is abandoned, `packages/ui` is the only place to swap.
- Next.js adds a Node server per panel. ADR-0034 uses that server as the BFF the platform design asked for.

## Alternatives rejected
- **Radix Primitives:** mature, but slower-moving; no capability we need that Base UI lacks.
- **A styled kit (MUI, Ant, Mantine):** their visual system conflicts with ADR-0017 and the tokens.
- **Plain CSS modules without Tailwind:** more code per component and no compile-time check
  that only tokens are used.
