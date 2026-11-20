import type { MenuItem } from '@mondapac/ui';
import { ROW_ACTIONS, type AlertListRow } from './list-types.ts';

/**
 * The Actions menu of an alert row: exactly the actions the row's `actions` array names (the
 * server decides per caller, state and severity), in a fixed order; an id this panel does not know
 * is ignored. An alert is acknowledged and resolved on its own page, where the version is checked
 * and a resolution and a note are asked for, so each item opens that page. Acknowledge and Resolve
 * end in "…" because they ask for more.
 */
export function alertRowActions(
  row: AlertListRow,
  label: (action: (typeof ROW_ACTIONS)[number]) => string,
  go: (alertId: string) => void,
): readonly MenuItem[] {
  return ROW_ACTIONS.filter((action) => row.actions.includes(action)).map((action): MenuItem => ({
    id: action,
    label: label(action),
    onSelect: () => go(row.id),
  }));
}
