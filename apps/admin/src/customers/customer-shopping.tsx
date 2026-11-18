'use client';

import { Badge, Banner, Button, Card, EmptyState, SkeletonRows, SuperTable } from '@mondapac/ui';
import { useLocale, useTranslations } from 'next-intl';
import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import { callApi, type ApiResult } from '../api/client.ts';
import { numberFormat } from '../shared/intl.ts';
import { shortId } from '../shared/short-id.ts';
import { formatMinor } from '../wallet/money.ts';
import { SectionList, type SectionColumn } from './customer-section-list.tsx';
import { timeOf } from './format.ts';
import {
  ASSISTANT_VIEW,
  BEHAVIOUR_VIEW,
  CART_VIEW,
  REMINDER_VIEW,
  type CartAnswer,
  type BehaviourAnswer,
} from './page-types.ts';

// The Shopping tab of the customer page (customers management phase 2b): the current cart and the
// behaviour summary (single reads), then the saved-for-later list, the abandoned-cart reminders,
// the add-to-cart history and the assistant conversations (super lists). Each section loads on its
// own under its own key. The API answers with ids, never names (a gap recorded in the PR), and
// never the search text or what was said to the assistant, so nothing here can show them.

export interface SectionContext {
  readonly accountId: string;
  readonly adminAccountId: string;
  readonly marketId: string;
  readonly csrfToken: string;
  readonly zone: string;
  readonly paging: 'pages' | 'prev-next';
  readonly keys: ReadonlySet<string>;
}

type Load<T> =
  | { readonly state: 'loading' }
  | { readonly state: 'failed'; readonly minutes: number | null }
  | { readonly state: 'hidden' }
  | { readonly state: 'ready'; readonly body: T };

/** One GET of a section; a 403 hides it, a 429 says when to come back, other failures retry. */
function useRead<T>(accountKey: string, read: () => Promise<ApiResult<T>>) {
  const [load, setLoad] = useState<Load<T>>({ state: 'loading' });
  const latest = useRef(0);
  // The reader is built from the account id alone, so the latest one always reads the same route.
  const reader = useRef(read);
  useEffect(() => {
    reader.current = read;
  });
  const run = useCallback(async () => {
    const ticket = ++latest.current;
    setLoad({ state: 'loading' });
    const result = await reader.current();
    if (ticket !== latest.current) return;
    if (result.ok) {
      setLoad({ state: 'ready', body: result.body });
      return;
    }
    if (result.failure.status === 401) {
      window.location.assign('/session-ended');
      return;
    }
    if (result.failure.status === 403) setLoad({ state: 'hidden' });
    else {
      setLoad({
        state: 'failed',
        minutes:
          result.failure.status === 429
            ? Math.max(1, Math.ceil((result.failure.details?.retryAfterSeconds ?? 60) / 60))
            : null,
      });
    }
  }, [accountKey]);
  useEffect(() => {
    void run();
  }, [run]);
  return { load, retry: () => void run() };
}

function ReadCard<T>({
  title,
  load,
  retry,
  children,
}: {
  readonly title: string;
  readonly load: Load<T>;
  readonly retry: () => void;
  readonly children: (body: T) => ReactNode;
}) {
  const ts = useTranslations('customers.sections');
  if (load.state === 'hidden') return null;
  return (
    <Card title={title}>
      {load.state === 'loading' ? (
        <SkeletonRows label={ts('loading', { section: title })} rows={3} />
      ) : load.state === 'failed' ? (
        <Banner tone="critical">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <span>
              {load.minutes === null
                ? ts('error.unavailable', { section: title })
                : ts('error.throttled', { minutes: load.minutes })}
            </span>
            <Button variant="secondary" onClick={retry}>
              {ts('retry')}
            </Button>
          </div>
        </Banner>
      ) : (
        children(load.body)
      )}
    </Card>
  );
}

const Reference = ({ id }: { readonly id: string }) => (
  <span className="font-mono text-xs wrap-anywhere" title={id}>
    {shortId(id)}
  </span>
);

function CurrentCart({ context }: { readonly context: SectionContext }) {
  const t = useTranslations('customers.shopping.cart');
  const locale = useLocale();
  const id = encodeURIComponent(context.accountId);
  const { load, retry } = useRead<CartAnswer>(id, () =>
    callApi<CartAnswer>('GET', `customers/admin/customers/${id}/cart`),
  );
  type Line = NonNullable<CartAnswer['cart']>['lines'][number];
  return (
    <ReadCard title={t('title')} load={load} retry={retry}>
      {(body) =>
        body.cart === null ? (
          <EmptyState size="compact" icon="package" title={t('empty')} />
        ) : (
          <div className="flex flex-col gap-3">
            <p className="text-sm text-fg-muted">
              {t('changed', { time: timeOf(body.cart.lastChangedAt, locale, context.zone) })}
              {' · '}
              {t('saved-count', { count: body.savedCount })}
            </p>
            <SuperTable<Line>
              caption={t('caption')}
              rows={body.cart.lines}
              rowId={(line) => `${line.offerId}-${line.variantId}`}
              rowName={(line) => shortId(line.offerId)}
              columns={[
                {
                  id: 'offer',
                  header: t('col.offer'),
                  primary: true,
                  cell: (line) => <Reference id={line.offerId} />,
                },
                {
                  id: 'variant',
                  header: t('col.variant'),
                  cell: (line) => <Reference id={line.variantId} />,
                },
                {
                  id: 'price',
                  header: t('col.price'),
                  numeric: true,
                  cell: (line) =>
                    formatMinor(line.priceAtAdd.amount, line.priceAtAdd.currency, locale),
                },
                {
                  id: 'quantity',
                  header: t('col.quantity'),
                  numeric: true,
                  cell: (line) => numberFormat(locale, {}).format(line.quantity),
                },
                {
                  id: 'added',
                  header: t('col.added'),
                  cell: (line) => timeOf(line.addedAt, locale, context.zone),
                },
              ]}
              minWidthClass="lg:min-w-160"
            />
          </div>
        )
      }
    </ReadCard>
  );
}

function Behaviour({ context }: { readonly context: SectionContext }) {
  const t = useTranslations('customers.shopping.behaviour');
  const locale = useLocale();
  const number = (value: number) => numberFormat(locale, {}).format(value);
  const id = encodeURIComponent(context.accountId);
  const { load, retry } = useRead<BehaviourAnswer>(id, () =>
    callApi<BehaviourAnswer>('GET', `customers/admin/customers/${id}/behaviour`),
  );
  return (
    <ReadCard title={t('title')} load={load} retry={retry}>
      {(body) => (
        <div className="flex flex-col gap-4">
          <p className="flex flex-wrap items-center gap-2">
            <span className="text-sm font-medium text-fg-secondary">{t('personalization')}</span>
            <Badge tone={body.personalization.enabled ? 'success' : 'neutral'}>
              {body.personalization.enabled ? t('on') : t('off')}
            </Badge>
            {body.personalization.changedAt === null ? null : (
              <span className="text-sm text-fg-muted">
                {t('changed', {
                  time: timeOf(body.personalization.changedAt, locale, context.zone),
                })}
              </span>
            )}
          </p>
          <p className="text-sm text-fg-muted">{t('window')}</p>
          <ul aria-label={t('figures')} className="grid gap-3 sm:grid-cols-3">
            {(
              [
                ['productViews', body.summary.productViews],
                ['categoryViews', body.summary.categoryViews],
                ['cartAdditions', body.summary.cartAdditions],
              ] as const
            ).map(([id, value]) => (
              <li
                key={id}
                className="flex min-w-0 flex-col gap-1 rounded-lg border border-line bg-surface p-4"
              >
                <span className="text-sm font-medium text-fg-secondary">{t(`figure.${id}`)}</span>
                <span className="text-2xl font-semibold tabular-nums">{number(value)}</span>
              </li>
            ))}
          </ul>
          <div className="flex flex-col gap-2">
            <h3 className="text-sm font-medium text-fg-secondary">{t('top')}</h3>
            {body.summary.topCategories.length === 0 ? (
              <p className="text-fg-muted">{t('top-empty')}</p>
            ) : (
              <ol className="flex flex-col divide-y divide-line-row">
                {body.summary.topCategories.map((category) => (
                  <li
                    key={category.categoryId}
                    className="flex items-center justify-between gap-3 py-2"
                  >
                    <span>
                      {t('category')} <Reference id={category.categoryId} />
                    </span>
                    <span className="tabular-nums">{t('views', { count: category.views })}</span>
                  </li>
                ))}
              </ol>
            )}
          </div>
        </div>
      )}
    </ReadCard>
  );
}

interface SavedRow {
  readonly savedItemId: string;
  readonly offerId: string;
  readonly variantId: string;
  readonly savedAt: string;
}
interface ReminderRow {
  readonly sentAt: string;
  readonly stage: 1 | 2;
  readonly cartChangedAt: string;
}
interface AdditionRow {
  readonly offerId: string;
  readonly variantId: string;
  readonly addedAt: string;
}
interface ConversationRow {
  readonly startedAt: string;
  readonly lastMessageAt: string;
}

/** The Shopping tab: six sections, each under its own key, loaded on its own. */
export function CustomerShopping(context: SectionContext) {
  const t = useTranslations('customers.shopping');
  const locale = useLocale();
  const { keys } = context;
  const time = (iso: string) => timeOf(iso, locale, context.zone);
  const common = { ...context };

  const saved: SectionColumn<SavedRow>[] = [
    { id: 'offer', primary: true, cell: (row) => <Reference id={row.offerId} /> },
    { id: 'variant', cell: (row) => <Reference id={row.variantId} /> },
    { id: 'saved', cell: (row) => time(row.savedAt) },
  ];
  const reminders: SectionColumn<ReminderRow>[] = [
    {
      id: 'stage',
      primary: true,
      cell: (row) => <Badge tone="info">{t('reminders.stage', { stage: row.stage })}</Badge>,
    },
    { id: 'cart-changed', cell: (row) => time(row.cartChangedAt) },
    { id: 'sent', cell: (row) => time(row.sentAt) },
  ];
  const additions: SectionColumn<AdditionRow>[] = [
    { id: 'offer', primary: true, cell: (row) => <Reference id={row.offerId} /> },
    { id: 'variant', cell: (row) => <Reference id={row.variantId} /> },
    { id: 'added', cell: (row) => time(row.addedAt) },
  ];
  const conversations: SectionColumn<ConversationRow>[] = [
    { id: 'started', primary: true, cell: (row) => time(row.startedAt) },
    { id: 'last', cell: (row) => time(row.lastMessageAt) },
  ];

  return (
    <div className="flex flex-col gap-4">
      {keys.has(CART_VIEW) ? <CurrentCart context={context} /> : null}
      {keys.has(CART_VIEW) ? (
        <SectionList<SavedRow>
          {...common}
          path="saved-items"
          ns="customers.shopping.saved"
          columns={saved}
          optional={['variant']}
          defaultOptional={['variant']}
          filter={{ kind: 'none' }}
          sortColumn="saved"
          rowId={(row) => row.savedItemId}
          rowName={(row) => shortId(row.offerId)}
        />
      ) : null}
      {keys.has(REMINDER_VIEW) ? (
        <SectionList<ReminderRow>
          {...common}
          path="cart-reminders"
          ns="customers.shopping.reminders"
          columns={reminders}
          optional={['cart-changed']}
          defaultOptional={['cart-changed']}
          filter={{ kind: 'none' }}
          sortColumn="sent"
          rowId={(row) => `${row.sentAt}-${row.stage}`}
          rowName={(row) => t('reminders.stage', { stage: row.stage })}
        />
      ) : null}
      {keys.has(BEHAVIOUR_VIEW) ? (
        <SectionList<AdditionRow>
          {...common}
          path="cart-additions"
          ns="customers.shopping.additions"
          columns={additions}
          optional={['variant']}
          defaultOptional={['variant']}
          filter={{ kind: 'range' }}
          sortColumn="added"
          rowId={(row, index) => `${row.offerId}-${row.variantId}-${row.addedAt}-${index}`}
          rowName={(row) => shortId(row.offerId)}
        />
      ) : null}
      {keys.has(BEHAVIOUR_VIEW) ? <Behaviour context={context} /> : null}
      {keys.has(ASSISTANT_VIEW) ? (
        <SectionList<ConversationRow>
          {...common}
          path="assistant-conversations"
          ns="customers.shopping.assistant"
          columns={conversations}
          optional={['last']}
          defaultOptional={['last']}
          filter={{ kind: 'none' }}
          sortColumn="started"
          rowId={(row) => row.startedAt}
          rowName={(row) => time(row.startedAt)}
          aside={(answer) =>
            typeof answer['conversationCount'] === 'number'
              ? t('assistant.count', { count: answer['conversationCount'] })
              : null
          }
        />
      ) : null}
    </div>
  );
}
