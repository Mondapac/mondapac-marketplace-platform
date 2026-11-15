import type { CallContext } from '@mondapac/shared-kernel';

// The row Actions menu of a super list ("…" in the last column): the server names the actions
// each row offers to the caller, from the caller's permissions and the row's state, so the menu
// the panel draws is the menu the server will honour.

/** One action a row can offer: its id, the permission key it needs, and the state it needs. */
export interface RowActionRule<Row> {
  readonly id: string;
  /**
   * The permission key the action's own use case checks (a function when it depends on the row);
   * null when the list's own key suffices.
   */
  readonly permission: string | null | ((row: Row) => string | null);
  /** Whether the row is in a state the action can run on; absent means always. */
  readonly when?: (row: Row) => boolean;
}

/** The action ids a row offers, in the order of `rules`. */
export function rowActions<Row>(
  row: Row,
  rules: readonly RowActionRule<Row>[],
  granted: ReadonlySet<string>,
): string[] {
  return rules
    .filter((rule) => rule.when?.(row) ?? true)
    .filter((rule) => {
      const key = typeof rule.permission === 'function' ? rule.permission(row) : rule.permission;
      return key === null || granted.has(key);
    })
    .map((rule) => rule.id);
}

/**
 * What {@link heldKeys} needs of a probe: its `execute`. A probe is a use case of the module that
 * answers `ok` when the caller holds one key and `access.denied` otherwise (the saved-filter share
 * check works the same way): the gate, in one place, decides which keys the caller holds.
 */
export interface PermissionProbe {
  execute(context: CallContext, input: Record<string, never>): Promise<{ readonly ok: boolean }>;
}

/**
 * The keys of `probes` the caller holds. A probe that answers anything but `ok` (denied or
 * unavailable) counts as not held: a missing action is safe, a shown one is checked again when run.
 */
export async function heldKeys(
  context: CallContext,
  probes: Readonly<Record<string, PermissionProbe>>,
): Promise<Set<string>> {
  const held = new Set<string>();
  await Promise.all(
    Object.entries(probes).map(async ([key, probe]) => {
      try {
        const answer = await probe.execute(context, {});
        if (answer.ok) held.add(key);
      } catch {
        // Unavailable: the action is not offered.
      }
    }),
  );
  return held;
}
