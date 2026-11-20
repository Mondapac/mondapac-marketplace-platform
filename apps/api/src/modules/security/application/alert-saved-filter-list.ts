import { err, ok } from '@mondapac/shared-kernel';
import type { Result } from '@mondapac/shared-kernel';
import type { ListDefinition, ListPayloadFailure } from '../../lists';
import { SECURITY_ALERTS_SAVED_FILTER_SHARE, SECURITY_VIEW } from '../contracts/permissions';
import {
  ALERT_LIST_VIEWS,
  ALERT_SORT_KEYS,
  type AlertListView,
  type AlertSortKey,
} from '../domain/alert-list';
import { ALERT_KEY_TYPES, SECURITY_RULES, type AlertKeyType } from '../domain/rules';
import { SEVERITIES, type SecuritySeverity } from '../domain/severity';

// The saved filters of the security centre's alert list (super list phase 3, list 37; CLAUDE.md
// rule 14), through the generic routes of `lists`. This module keeps the meaning of a saved
// filter's document and the keys that guard the list; `lists` keeps the table, the caps, the names
// and the sharing rules. The document is closed: the view, the severities, a rule of the
// catalogue, a key type, a date preset for when the alert opened, a minimum event count, the sort
// and its direction. The key value (an account id or an address) and any pasted text are never
// saved, so a shared filter carries no account or address.

export const ALERT_LIST_KEY = 'admin.security.alerts';

/**
 * The date presets a saved filter may hold. The panel turns one into instants on its own clock when
 * it applies the filter, so a saved "Last 7 days" keeps meaning the last seven days.
 */
export const ALERT_DATE_PRESETS = [
  'today',
  'yesterday',
  'last-7-days',
  'last-30-days',
  'this-month',
  'last-month',
] as const;
export type AlertDatePreset = (typeof ALERT_DATE_PRESETS)[number];

/** The same bound as the list's own `minEvents` (nine digits), so a filter that runs can be saved. */
export const ALERT_MIN_EVENTS_MAX = 999_999_999;

/** The closed document of a saved filter, in its canonical form (an unset part is left out). */
export interface AlertFilterPayload {
  readonly v: 1;
  readonly view: AlertListView;
  readonly filters?: {
    readonly severities?: readonly SecuritySeverity[];
    readonly rule?: string;
    readonly keyType?: AlertKeyType;
    readonly opened?: AlertDatePreset;
    readonly minEvents?: number;
  };
  readonly sort?: AlertSortKey;
  readonly direction?: 'asc' | 'desc';
}

const TOP_KEYS = ['v', 'view', 'filters', 'sort', 'direction'] as const;
const FILTER_KEYS = ['severities', 'rule', 'keyType', 'opened', 'minEvents'] as const;

const invalid = (path: string, code: string): { ok: false; error: ListPayloadFailure } =>
  err({ code: 'validation.failed', fields: [{ path, code }] }) as {
    ok: false;
    error: ListPayloadFailure;
  };

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const unset = (value: unknown): boolean => value === undefined || value === null || value === '';

/**
 * Reads a saved filter's document and returns its canonical form, or the first field it refuses
 * (`payload.<path>`, `unknown`, `type` or `value`). Severities are kept once each, in the order of
 * the catalogue, so two documents that mean the same filter are the same document.
 */
export function parseAlertFilterPayload(
  raw: unknown,
): Result<AlertFilterPayload, ListPayloadFailure> {
  if (!isRecord(raw)) return invalid('payload', 'type');
  for (const key of Object.keys(raw)) {
    if (!(TOP_KEYS as readonly string[]).includes(key)) return invalid(`payload.${key}`, 'unknown');
  }
  if (raw['v'] !== 1) return invalid('payload.v', 'value');
  const view = raw['view'];
  if (typeof view !== 'string') return invalid('payload.view', 'type');
  const knownView = ALERT_LIST_VIEWS.find((candidate) => candidate === view);
  if (knownView === undefined) return invalid('payload.view', 'value');

  let severities: SecuritySeverity[] = [];
  let rule: string | undefined;
  let keyType: AlertKeyType | undefined;
  let opened: AlertDatePreset | undefined;
  let minEvents: number | undefined;
  const given = raw['filters'];
  if (!unset(given)) {
    if (!isRecord(given)) return invalid('payload.filters', 'type');
    for (const key of Object.keys(given)) {
      if (!(FILTER_KEYS as readonly string[]).includes(key)) {
        return invalid(`payload.filters.${key}`, 'unknown');
      }
    }
    const listed = given['severities'];
    if (!unset(listed)) {
      if (!Array.isArray(listed)) return invalid('payload.filters.severities', 'type');
      const chosen = new Set<string>();
      for (const item of listed) {
        if (typeof item !== 'string' || !(SEVERITIES as readonly string[]).includes(item)) {
          return invalid('payload.filters.severities', 'value');
        }
        chosen.add(item);
      }
      severities = SEVERITIES.filter((candidate) => chosen.has(candidate));
    }
    const code = given['rule'];
    if (!unset(code)) {
      const known = SECURITY_RULES.find((candidate) => candidate.code === code);
      if (known === undefined) return invalid('payload.filters.rule', 'value');
      rule = known.code;
    }
    const type = given['keyType'];
    if (!unset(type)) {
      keyType = ALERT_KEY_TYPES.find((candidate) => candidate === type);
      if (keyType === undefined) return invalid('payload.filters.keyType', 'value');
    }
    const preset = given['opened'];
    if (!unset(preset)) {
      opened = ALERT_DATE_PRESETS.find((candidate) => candidate === preset);
      if (opened === undefined) return invalid('payload.filters.opened', 'value');
    }
    const count = given['minEvents'];
    if (!unset(count)) {
      if (typeof count !== 'number') return invalid('payload.filters.minEvents', 'type');
      if (!Number.isInteger(count) || count < 1 || count > ALERT_MIN_EVENTS_MAX) {
        return invalid('payload.filters.minEvents', 'value');
      }
      minEvents = count;
    }
  }

  const sort = raw['sort'];
  let knownSort: AlertSortKey | undefined;
  if (!unset(sort)) {
    knownSort = ALERT_SORT_KEYS.find((candidate) => candidate === sort);
    if (knownSort === undefined) return invalid('payload.sort', 'value');
  }
  const direction = raw['direction'];
  if (!unset(direction) && direction !== 'asc' && direction !== 'desc') {
    return invalid('payload.direction', 'value');
  }

  const filters: NonNullable<AlertFilterPayload['filters']> = {
    ...(severities.length === 0 ? {} : { severities }),
    ...(rule === undefined ? {} : { rule }),
    ...(keyType === undefined ? {} : { keyType }),
    ...(opened === undefined ? {} : { opened }),
    ...(minEvents === undefined ? {} : { minEvents }),
  };
  return ok({
    v: 1,
    view: knownView,
    ...(Object.keys(filters).length === 0 ? {} : { filters }),
    ...(knownSort === undefined ? {} : { sort: knownSort }),
    ...(direction === 'asc' || direction === 'desc' ? { direction } : {}),
  });
}

/**
 * The list security registers for the on-call: the alert list, guarded by the centre's view key;
 * sharing a filter with every admin needs the module's own protected share key.
 */
export const SECURITY_ALERT_LISTS: readonly ListDefinition[] = [
  {
    listKey: ALERT_LIST_KEY,
    population: 'admin',
    viewKey: SECURITY_VIEW.key,
    shareKey: SECURITY_ALERTS_SAVED_FILTER_SHARE.key,
    parsePayload: (raw) => parseAlertFilterPayload(raw),
  },
];
