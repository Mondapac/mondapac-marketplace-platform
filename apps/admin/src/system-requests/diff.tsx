'use client';

import { Banner, Button, Card, DataList } from '@mondapac/ui';
import { useLocale, useTranslations } from 'next-intl';
import { useState, type ReactNode } from 'react';
import { numberFormat } from '../shared/intl.ts';
import { formatMinor } from '../wallet/money.ts';

type Values = Readonly<Record<string, unknown>>;

/** How the panel words one field of one kind; a field the registry lacks is shown by its value. */
type FieldKind = 'percent-bps' | 'text';

/**
 * The per-kind renderer registry: which fields hold something that needs more than its raw value
 * (a rate in basis points), and what a null value means for the field. A kind that is not here
 * falls back to the generic key and value list, which is always safe: values are inert text.
 */
const REGISTRY: Readonly<
  Record<
    string,
    Readonly<Record<string, { readonly kind?: FieldKind; readonly empty?: 'market-default' }>>
  >
> = {
  'commission-payouts.commission-rate': {
    rateBps: { kind: 'percent-bps', empty: 'market-default' },
  },
  'commission-payouts.payout-terms': {},
  'wallet.market-status': {},
};

/** "maxRefund" -> "Max refund", "list-paging" -> "List paging". */
export function humanKey(key: string): string {
  const spaced = key
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/[_-]+/g, ' ')
    .trim()
    .toLowerCase();
  return spaced.charAt(0).toUpperCase() + spaced.slice(1);
}

const isRecord = (value: unknown): value is Values =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const isMoney = (value: unknown): value is { amount: string | number; currency: string } =>
  isRecord(value) &&
  Object.keys(value).length === 2 &&
  (typeof value['amount'] === 'string' || typeof value['amount'] === 'number') &&
  typeof value['currency'] === 'string';

/** True when two JSON values are the same, key order aside. */
export function sameValue(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (Array.isArray(a) && Array.isArray(b)) {
    return a.length === b.length && a.every((entry, index) => sameValue(entry, b[index]));
  }
  if (isRecord(a) && isRecord(b)) {
    const keys = Object.keys(a);
    return (
      keys.length === Object.keys(b).length &&
      keys.every((key) => key in b && sameValue(a[key], b[key]))
    );
  }
  return false;
}

/** The field names of a diff: the after's own order first, then names only the before had. */
export function diffKeys(before: Values, after: Values): readonly string[] {
  return [...Object.keys(after), ...Object.keys(before).filter((key) => !(key in after))];
}

function Value({
  kind,
  field,
  value,
  depth = 0,
}: {
  readonly kind: string;
  readonly field: string;
  readonly value: unknown;
  readonly depth?: number;
}): ReactNode {
  const t = useTranslations('system-requests.diff');
  const locale = useLocale();
  const rule = REGISTRY[kind]?.[field];
  if (value === null || value === undefined) {
    return (
      <span className="text-fg-muted">
        {rule?.empty === 'market-default' ? t('market-default') : t('not-set')}
      </span>
    );
  }
  if (typeof value === 'boolean') return <>{value ? t('on') : t('off')}</>;
  if (typeof value === 'number') {
    if (rule?.kind === 'percent-bps') {
      return (
        <>
          {numberFormat(locale, { style: 'percent', maximumFractionDigits: 2 }).format(
            value / 10_000,
          )}
        </>
      );
    }
    return <>{numberFormat(locale, {}).format(value)}</>;
  }
  if (typeof value === 'string') {
    return value === '' ? (
      <span className="text-fg-muted">{t('empty')}</span>
    ) : (
      <span className="whitespace-pre-wrap break-words">{value}</span>
    );
  }
  if (isMoney(value)) {
    const minor = String(value.amount);
    return (
      <>
        {/^[0-9]{1,18}$/.test(minor)
          ? formatMinor(minor, value.currency, locale)
          : `${minor} ${value.currency}`}
      </>
    );
  }
  if (Array.isArray(value)) {
    if (value.length === 0) return <span className="text-fg-muted">{t('empty')}</span>;
    if (depth >= 2 || value.some((entry) => typeof entry === 'object' && entry !== null)) {
      return <code className="break-all text-xs">{JSON.stringify(value)}</code>;
    }
    return <span className="break-words">{value.map(String).join(', ')}</span>;
  }
  if (isRecord(value)) {
    if (depth >= 2) return <code className="break-all text-xs">{JSON.stringify(value)}</code>;
    return (
      <dl className="flex flex-col gap-1">
        {Object.entries(value).map(([key, inner]) => (
          <div key={key} className="flex flex-wrap gap-x-2">
            <dt className="text-fg-muted">{humanKey(key)}:</dt>
            <dd>
              <Value kind={kind} field={key} value={inner} depth={depth + 1} />
            </dd>
          </div>
        ))}
      </dl>
    );
  }
  return <code className="break-all text-xs">{JSON.stringify(value)}</code>;
}

/**
 * The "What changed" card: Before (the value a reject restores) and After (live now) side by
 * side, aligned by field; a changed field has a marker and the words "changed" for screen
 * readers; unchanged fields sit behind a disclosure. Shown only when the API sent both sides;
 * otherwise a note says who may see them. A decided or superseded request keeps the card as
 * history. On a phone the columns stack, After first.
 */
export function ChangeDiff({
  kind,
  before,
  after,
  history,
}: {
  readonly kind: string;
  readonly before: Values | null;
  readonly after: Values | null;
  /** The request is decided or superseded: the card is a record of the change. */
  readonly history: boolean;
}) {
  const t = useTranslations('system-requests.diff');
  const [showSame, setShowSame] = useState(false);
  if (before === null || after === null) {
    return (
      <Card title={t('title')}>
        <Banner tone="info">{t('hidden')}</Banner>
      </Card>
    );
  }
  const keys = diffKeys(before, after);
  const changed = keys.filter((key) => !sameValue(before[key], after[key]));
  const same = keys.filter((key) => sameValue(before[key], after[key]));
  const row = (key: string, isChanged: boolean) => (
    <li
      key={key}
      className={`flex flex-col gap-1 border-s-4 px-4 py-3 ${isChanged ? 'border-attention-border' : 'border-transparent'}`}
    >
      <p className="text-sm font-medium text-fg">
        {humanKey(key)}
        {isChanged ? <span className="sr-only"> ({t('changed')})</span> : null}
      </p>
      <div className="grid gap-3 text-sm sm:grid-cols-2">
        {/* DOM order is Before, then After; a phone shows After first. */}
        <div className="flex flex-col gap-0.5 max-sm:order-2">
          <span className="text-xs text-fg-muted">{t('before')}</span>
          <div className="min-w-0">
            <Value kind={kind} field={key} value={before[key]} />
          </div>
        </div>
        <div className="flex flex-col gap-0.5 max-sm:order-1">
          <span className="text-xs text-fg-muted">{t('after')}</span>
          <div className="min-w-0">
            <Value kind={kind} field={key} value={after[key]} />
          </div>
        </div>
      </div>
    </li>
  );
  return (
    <Card title={history ? t('title-history') : t('title')} flush>
      <div className="hidden gap-3 border-b border-line-row bg-muted px-4 py-2 text-xs font-medium text-fg-muted sm:grid sm:grid-cols-2">
        <span>
          {t('before')} <span className="font-normal">({t('before-help')})</span>
        </span>
        <span>
          {t('after')} <span className="font-normal">({t('after-help')})</span>
        </span>
      </div>
      <ul className="divide-y divide-line-row">
        {changed.map((key) => row(key, true))}
        {changed.length === 0 ? (
          <li className="px-4 py-3 text-sm text-fg-muted">{t('no-changes')}</li>
        ) : null}
      </ul>
      {same.length > 0 ? (
        <div className="border-t border-line-row px-4 py-2">
          <Button
            variant="link"
            className="max-sm:min-h-11"
            aria-expanded={showSame}
            onClick={() => setShowSame((current) => !current)}
          >
            {showSame ? t('hide-unchanged') : t('show-unchanged', { count: same.length })}
          </Button>
          {showSame ? (
            <ul className="mt-1 divide-y divide-line-row">{same.map((key) => row(key, false))}</ul>
          ) : null}
        </div>
      ) : null}
    </Card>
  );
}

/** The action names the panel words; any other is shown by its own name. */
const ACTIONS = ['delete', 'merge', 'import'] as const;

/**
 * The "Requested action" card of a request that waits for approval: the action (from
 * `after.action`) with its details, and what the subject holds now (`before`) as the values the
 * action would apply to. There is no Current/Proposed diff: nothing has been changed. Without
 * `after` a note says who may see the details; without `before` the second card is left out.
 */
export function RequestedAction({
  kind,
  before,
  after,
  history,
}: {
  readonly kind: string;
  readonly before: Values | null;
  readonly after: Values | null;
  /** The request is decided: the card is a record of what was asked. */
  readonly history: boolean;
}) {
  const t = useTranslations('system-requests.requested');
  if (after === null) {
    return (
      <Card title={t('title')}>
        <Banner tone="info">{t('hidden')}</Banner>
      </Card>
    );
  }
  const action = typeof after['action'] === 'string' ? after['action'] : null;
  const into =
    typeof after['intoName'] === 'string' && after['intoName'] !== '' ? after['intoName'] : null;
  const name =
    action === 'merge' && into !== null
      ? t('merge-into', { name: into })
      : action === null
        ? t('unknown-action')
        : (ACTIONS as readonly string[]).includes(action)
          ? t(`action.${action}`)
          : humanKey(action);
  const details = Object.entries(after).filter(
    ([key]) => key !== 'action' && !(key === 'intoName' && into !== null),
  );
  return (
    <>
      <Card title={history ? t('title-history') : t('title')}>
        <p className="text-base font-medium text-fg">{name}</p>
        {details.length > 0 ? (
          <DataList
            missing={t('none')}
            rows={details.map(([key, value]) => ({
              label: humanKey(key),
              value: <Value kind={kind} field={key} value={value} />,
            }))}
          />
        ) : null}
      </Card>
      {before === null ? null : (
        <Card title={t('current-title')}>
          {Object.keys(before).length === 0 ? (
            <p className="text-sm text-fg-muted">{t('none')}</p>
          ) : (
            <DataList
              missing={t('none')}
              rows={Object.entries(before).map(([key, value]) => ({
                label: humanKey(key),
                value: <Value kind={kind} field={key} value={value} />,
              }))}
            />
          )}
        </Card>
      )}
    </>
  );
}
