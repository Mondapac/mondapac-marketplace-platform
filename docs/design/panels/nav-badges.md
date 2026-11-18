# Menu badges (panel shell)

A menu item can show a count (for example the System requests items that wait for the admin).

- `NavItem.badgeSource` names a source (`apps/admin/src/nav.ts`). The shell wraps the app in
  `NavBadgeProvider` (`packages/ui/src/shell/nav-badges.tsx`); the sidebar only draws what the
  provider holds.
- An app component fetches the count and calls `useSetNavBadge(source, value | null)` with
  `{count, tone: 'info' | 'critical', label}`. `label` is the spoken text added after the item's
  name; the pill itself is `aria-hidden`. A failed read or a count of 0 clears the badge: the menu
  never shows an error.
- A count above 99 reads "99+". The pill is hidden on the collapsed rail. A closed group header
  shows the sum of its items' badges.
- The System requests source (`apps/admin/src/system-requests/nav-badge.tsx`) never calls the API
  for an admin without `system-requests.request.view`, and refreshes on load, on focus (at most
  every 10 s), after a decision and every 60 s while the tab is visible.
- `TabItem.tone = 'critical'` colours a view tab (the Overdue view) without changing its role.
