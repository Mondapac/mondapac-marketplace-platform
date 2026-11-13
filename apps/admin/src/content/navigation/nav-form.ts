import type { PageDetail } from '../pages/page-types.ts';

// The form of the buyer site's navigation (storefront `replaceNavigationDraft`): the left-rail
// items (nav-link) and the Browse drawer's category lists (nav-category), as plain values, the
// checks the API makes and the body it takes. The API stays the judge: these checks only save a
// round trip.

export const NAV_READ_PERMISSION = 'storefront.page.read';
export const NAV_EDIT_PERMISSION = 'storefront.navigation.edit';
export const NAV_APPROVE_PERMISSION = 'storefront.navigation.approve';

export const NAVIGATION_PATH = '/content/navigation';
export const NAVIGATION_API_PATH = 'storefront/admin/navigation';
export const NAV_DRAFT_PATH = `${NAVIGATION_API_PATH}/draft`;
export const NAV_RESTORE_PATH = `${NAVIGATION_API_PATH}/restore`;
export const NAV_APPROVE_PATH = `${NAVIGATION_API_PATH}/approve`;

export const NAV_SLOTS = ['rail', 'drawer-popular', 'drawer-categories'] as const;
export type NavSlot = (typeof NAV_SLOTS)[number];
export const NAV_SLOT_MAX: Readonly<Record<NavSlot, number>> = {
  rail: 12,
  'drawer-popular': 12,
  'drawer-categories': 30,
};
export const LABEL_MAX = 40;
export const ICON_PATTERN = /^[a-z][a-z0-9-]{0,31}$/u;

export const TARGET_KINDS = ['category', 'page', 'system-page', 'path'] as const;
export type TargetKind = (typeof TARGET_KINDS)[number];

export interface NavItem {
  /** A local key for the row (rows are never renumbered by the key). */
  readonly key: string;
  readonly enabled: boolean;
  readonly label: string;
  /** Left menu only. */
  readonly icon: string;
  readonly kind: TargetKind;
  /** The category or page id, the system page key, or the site path. */
  readonly value: string;
  /** Browse lists only. */
  readonly categoryId: string;
}

export type NavDraft = Readonly<Record<NavSlot, readonly NavItem[]>>;

export type NavField = 'label' | 'icon' | 'value' | 'categoryId';
export type NavCode = 'required' | 'too-long' | 'format' | 'invalid';
/** Errors by row: `rail:0:label`. */
export type NavErrors = Readonly<Record<string, NavCode>>;
export const errorKey = (slot: NavSlot, index: number, field: NavField): string =>
  `${slot}:${index}:${field}`;

let counter = 0;
const nextKey = (): string => `row-${(counter += 1)}`;

const text = (value: unknown): string => (typeof value === 'string' ? value : '');
const record = (value: unknown): Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
const len = (value: string): number => [...value.trim()].length;

export const blankItem = (slot: NavSlot): NavItem => ({
  key: nextKey(),
  enabled: true,
  label: '',
  icon: '',
  kind: slot === 'rail' ? 'path' : 'category',
  value: '',
  categoryId: '',
});

/** The draft of a navigation page as the editor holds it. */
export function draftOf(page: PageDetail): NavDraft {
  const slots = {} as Record<NavSlot, NavItem[]>;
  for (const slot of NAV_SLOTS) {
    slots[slot] = (page.draft.placements[slot] ?? []).map((placement) => {
      const config = record(placement.config);
      const target = record(config.target);
      const kind = (TARGET_KINDS as readonly string[]).includes(text(target.kind))
        ? (text(target.kind) as TargetKind)
        : 'path';
      return {
        key: nextKey(),
        enabled: placement.enabled,
        label: text(config.label),
        icon: text(config.icon),
        kind,
        value:
          kind === 'path'
            ? text(target.path)
            : kind === 'system-page'
              ? text(target.key)
              : text(target.id),
        categoryId: text(config.categoryId),
      };
    });
  }
  return slots;
}

const sameItem = (a: NavItem, b: NavItem): boolean =>
  a.enabled === b.enabled &&
  a.label === b.label &&
  a.icon === b.icon &&
  a.kind === b.kind &&
  a.value === b.value &&
  a.categoryId === b.categoryId;

export const sameDraft = (a: NavDraft, b: NavDraft): boolean =>
  NAV_SLOTS.every(
    (slot) =>
      a[slot].length === b[slot].length && a[slot].every((item, i) => sameItem(item, b[slot][i]!)),
  );

export function validate(draft: NavDraft): NavErrors {
  const errors: Record<string, NavCode> = {};
  for (const slot of NAV_SLOTS) {
    draft[slot].forEach((item, index) => {
      const put = (field: NavField, code: NavCode) => {
        errors[errorKey(slot, index, field)] = code;
      };
      if (slot === 'rail') {
        if (item.label.trim() === '') put('label', 'required');
        else if (len(item.label) > LABEL_MAX) put('label', 'too-long');
        if (item.icon.trim() !== '' && !ICON_PATTERN.test(item.icon.trim())) put('icon', 'format');
        const value = item.value.trim();
        if (value === '') put('value', 'required');
        else if (item.kind === 'path' && (!value.startsWith('/') || value.startsWith('//'))) {
          put('value', 'format');
        }
      } else {
        if (item.categoryId === '') put('categoryId', 'required');
        if (len(item.label) > LABEL_MAX) put('label', 'too-long');
      }
    });
  }
  return errors;
}

/** The body of `PUT storefront/admin/navigation/draft`: the whole draft, in order. */
export function requestOf(draft: NavDraft): { readonly slots: Record<string, unknown[]> } {
  const slots: Record<string, unknown[]> = {};
  for (const slot of NAV_SLOTS) {
    slots[slot] = draft[slot].map((item) => {
      if (slot !== 'rail') {
        const config: Record<string, unknown> = { categoryId: item.categoryId };
        if (item.label.trim() !== '') config.label = item.label.trim();
        return { config, enabled: item.enabled };
      }
      const value = item.value.trim();
      const target =
        item.kind === 'path'
          ? { kind: 'path', path: value }
          : item.kind === 'system-page'
            ? { kind: 'system-page', key: value }
            : { kind: item.kind, id: value };
      const config: Record<string, unknown> = { label: item.label.trim(), target };
      if (item.icon.trim() !== '') config.icon = item.icon.trim();
      return { config, enabled: item.enabled };
    });
  }
  return { slots };
}

const PATH =
  /^slots\.(rail|drawer-popular|drawer-categories)(?:\[(\d+)\](?:\.(?:config\.)?(.+))?)?$/u;

/** The API's field problems as row errors; a slot-wide problem or an unknown path is `other`. */
export function mapProblems(
  problems: readonly { readonly path: string; readonly code: string }[],
): {
  readonly rows: NavErrors;
  readonly other: readonly string[];
} {
  const rows: Record<string, NavCode> = {};
  const other: string[] = [];
  for (const { path, code } of problems) {
    const match = PATH.exec(path);
    const slot = match?.[1] as NavSlot | undefined;
    const index = match?.[2];
    const rest = match?.[3] ?? '';
    const field: NavField | null =
      rest === 'label'
        ? 'label'
        : rest === 'icon'
          ? 'icon'
          : rest === 'categoryId'
            ? 'categoryId'
            : rest === 'target' || rest.startsWith('target.')
              ? 'value'
              : null;
    if (slot === undefined || index === undefined || field === null) {
      other.push(`${path}:${code}`);
      continue;
    }
    rows[errorKey(slot, Number(index), field)] =
      code === 'required'
        ? 'required'
        : code === 'length' || code === 'too-long' || code === 'max-length'
          ? 'too-long'
          : code === 'format'
            ? 'format'
            : 'invalid';
  }
  return { rows, other };
}

export const moved = <T>(list: readonly T[], index: number, by: -1 | 1): T[] => {
  const target = index + by;
  if (target < 0 || target >= list.length) return [...list];
  const copy = [...list];
  const [entry] = copy.splice(index, 1);
  copy.splice(target, 0, entry as T);
  return copy;
};
