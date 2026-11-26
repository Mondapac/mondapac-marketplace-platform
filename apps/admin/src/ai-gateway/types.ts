// Answers and keys of the AI Gateway routes (apps/api settings module, AI Gateway G4). The panel
// follows what the API answers; it decides nothing. Caps travel as whole US micro-dollars in text.

export const GATEWAY_VIEW_PERMISSION = 'settings.ai-gateway.view';
export const GATEWAY_MANAGE_PERMISSION = 'settings.ai-gateway.manage';

export const GATEWAY_PATH = 'settings/admin/ai-gateway';
export const GATEWAY_LIMITS_PATH = `${GATEWAY_PATH}/limits`;
export const GATEWAY_STOP_PATH = `${GATEWAY_PATH}/emergency-stop`;
export const GATEWAY_CAPABILITIES_PATH = `${GATEWAY_PATH}/capabilities`;
export const GATEWAY_HISTORY_PATH = `${GATEWAY_PATH}/history`;
export const GATEWAY_REVERT_PATH = `${GATEWAY_PATH}/revert`;

export const STOP_CODE = 'ai-gateway-emergency-stop';

/** The caps, in the order the page shows them; the evaluation cap is never `none`. */
export const CAP_CODES = [
  'ai-cap-market-day',
  'ai-cap-market-month',
  'ai-cap-capability-day',
  'ai-cap-seller-day',
  'ai-cap-guest-day',
  'ai-cap-buyer-chat-day',
  'ai-cap-buyer-chat-month',
  'ai-cap-evaluation-month',
] as const;
export type CapCode = (typeof CAP_CODES)[number];
export const NEVER_NONE: readonly string[] = ['ai-cap-evaluation-month'];

/** The capability switches the API names (G4d3), `on` by default. */
export const CAPABILITY_CODES = [
  'ai-capability-assistant-buyer-chat',
  'ai-capability-catalog-description-writer-seller',
  'ai-capability-catalog-description-writer-admin',
] as const;

/** The settings whose history the page can show and restore. */
export const HISTORY_CODES: readonly string[] = [STOP_CODE, ...CAP_CODES, ...CAPABILITY_CODES];

/** Largest cap the API takes, in micro-dollars (US$1 million). */
const MAX_MICRO = 1_000_000_000_000n;

export interface GatewaySetting {
  readonly code: string;
  readonly value: string;
  /** 0 while the default is in force. */
  readonly version: number;
  readonly updatedAt: string | null;
  readonly review?: { readonly reviewed: boolean; readonly risk: string };
}

export interface HistoryEntry {
  readonly code: string;
  readonly version: number;
  readonly previousValue: string | null;
  readonly value: string;
  readonly changedAt: string;
  readonly changedBy: string | null;
  readonly note: string | null;
  readonly current: boolean;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null;

/** The settings answer checked, or null when it is not what the panel expects. */
export function settingsOf(value: unknown): readonly GatewaySetting[] | null {
  if (!isRecord(value) || !Array.isArray(value['settings'])) return null;
  const rows: GatewaySetting[] = [];
  for (const row of value['settings'] as unknown[]) {
    if (
      !isRecord(row) ||
      typeof row['code'] !== 'string' ||
      typeof row['value'] !== 'string' ||
      !Number.isInteger(row['version'])
    ) {
      return null;
    }
    const review = row['review'];
    rows.push({
      code: row['code'],
      value: row['value'],
      version: row['version'] as number,
      updatedAt: typeof row['updatedAt'] === 'string' ? row['updatedAt'] : null,
      ...(isRecord(review) && typeof review['reviewed'] === 'boolean'
        ? {
            review: {
              reviewed: review['reviewed'],
              risk: typeof review['risk'] === 'string' ? review['risk'] : '',
            },
          }
        : {}),
    });
  }
  return rows;
}

export function historyOf(value: unknown): readonly HistoryEntry[] | null {
  if (!isRecord(value) || !Array.isArray(value['history'])) return null;
  const rows: HistoryEntry[] = [];
  for (const row of value['history'] as unknown[]) {
    if (
      !isRecord(row) ||
      typeof row['code'] !== 'string' ||
      typeof row['value'] !== 'string' ||
      typeof row['changedAt'] !== 'string' ||
      !Number.isInteger(row['version']) ||
      typeof row['current'] !== 'boolean'
    ) {
      return null;
    }
    rows.push({
      code: row['code'],
      version: row['version'] as number,
      previousValue: typeof row['previousValue'] === 'string' ? row['previousValue'] : null,
      value: row['value'],
      changedAt: row['changedAt'],
      changedBy: typeof row['changedBy'] === 'string' ? row['changedBy'] : null,
      note: typeof row['note'] === 'string' ? row['note'] : null,
      current: row['current'],
    });
  }
  return rows;
}

export const find = (rows: readonly GatewaySetting[], code: string): GatewaySetting =>
  rows.find((row) => row.code === code) ?? { code, value: '', version: 0, updatedAt: null };

/** Whole micro-dollars as US dollars text ("10", "0.5"); `none` stays `none`. */
export function microToDollars(micro: string): string {
  if (!/^\d+$/.test(micro)) return micro;
  const value = BigInt(micro);
  const whole = value / 1_000_000n;
  const fraction = (value % 1_000_000n).toString().padStart(6, '0').replace(/0+$/, '');
  return fraction === '' ? whole.toString() : `${whole.toString()}.${fraction}`;
}

/**
 * Dollars text the admin typed as micro-dollars: `none` (when allowed) or up to six decimals,
 * 0 to US$1 million. Null when it is not a value the API would take.
 */
export function dollarsToMicro(text: string, allowNone: boolean): string | null {
  const trimmed = text.trim().toLowerCase();
  if (trimmed === 'none') return allowNone ? 'none' : null;
  const match = /^(\d{1,7})(?:\.(\d{1,6}))?$/.exec(trimmed);
  if (match === null) return null;
  const micro = BigInt(match[1] ?? '0') * 1_000_000n + BigInt((match[2] ?? '').padEnd(6, '0'));
  return micro > MAX_MICRO ? null : micro.toString();
}

/** True when moving from `before` to `after` allows more AI spend (a raise or lifting a cap). */
export function raisesCap(before: string, after: string): boolean {
  if (before === after) return false;
  if (after === 'none') return true;
  if (before === 'none') return false;
  return BigInt(after) > BigInt(before);
}
