# Admin dashboard screenshots (not part of CI)

Renders the real `AdminDashboard` with fixture data (every card, an empty Market, one day of data,
and a partial one: net revenue incomplete, same-day share unavailable, a failed top sellers read,
refused sections) at 360, 375, 768 and 1280 px in light and dark. The panel shell is not drawn.
Run from `apps/admin`:

    VITE_PATH=<vite package folder> PLAYWRIGHT_PATH=<playwright package folder> \
      node test/dashboard-shots/run.mjs <out-dir>

Phase 2 cards: scenarios `p2-thin`, `p2-failed` (admin) and `goal-none`, `goal-failed`, `goal-read-only`, the goal dialog (seller); `SHOTS_ONLY=<view names>` takes only those views.

Drill-down: `admin-dashboard-drill-focus` (keyboard focus on a status link) and `admin-dashboard-drill-hover` (a pointer on a revenue chart day).
