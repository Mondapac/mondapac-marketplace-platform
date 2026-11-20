import type { MenuItem } from '@mondapac/ui';
import type { Action } from '../types.ts';
import { ROW_ACTIONS, type ModerationListRow } from './list-types.ts';

/**
 * The Actions menu of a moderation row: exactly the actions the row's `actions` array names (the
 * server decides per caller and status), in a fixed order; an id this panel does not know is
 * ignored. Open shows the review; every other item opens the same review dialog with that action
 * chosen, where the moderator picks a reason (and, to remove, types the review's short id) before
 * the change; the API asks for a fresh two-step code. Each of those labels ends in "…".
 */
export function moderationRowActions(
  row: ModerationListRow,
  label: (action: (typeof ROW_ACTIONS)[number]) => string,
  open: (reviewId: string, action: Action | null) => void,
): readonly MenuItem[] {
  return ROW_ACTIONS.filter((action) => row.actions.includes(action)).map((action): MenuItem => ({
    id: action,
    label: label(action),
    ...(action === 'remove' || action === 'hide' ? { tone: 'critical' as const } : {}),
    onSelect: () => open(row.id, action === 'open' ? null : action),
  }));
}
