'use client';

import {
  Badge,
  Banner,
  Button,
  LinkButton,
  type BadgeTone,
  type PagedAnswer,
  type PagedListConfig,
  type SuperColumn,
} from '@mondapac/ui';
import { useLocale, useTranslations } from 'next-intl';
import { useCallback, useMemo, useRef, useState, type ReactNode } from 'react';
import { PagedSuperList } from '../shared/paged-super-list.tsx';
import { pickLabel } from './draft-content.ts';
import { formatInstant, known } from './format.ts';
import { SUGGESTION_STATUSES, type OwnSuggestion, type OwnTopicSuggestion } from './types.ts';

const TONE: Record<string, BadgeTone> = {
  open: 'attention',
  approved: 'success',
  mapped: 'info',
  rejected: 'neutral',
  unknown: 'neutral',
};

type Translate = (key: string, values?: Record<string, string | number>) => string;

interface Context {
  readonly t: Translate;
  readonly defaultLocale: string;
  readonly locale: string;
  readonly timeZone: string | null;
}

/** What differs between the value list and the tag list: where it reads and how a row reads. */
interface Kind<Row> {
  readonly ns: 'catalog.suggestions' | 'catalog.tagSuggestions';
  readonly endpoint: string;
  readonly newHref: string;
  /** The columns after the label, in order. */
  readonly columns: readonly string[];
  readonly counterKey: 'waiting' | 'used';
  /** The limit reached: the button goes away (values) or stays, disabled (tags). */
  readonly fullButton: 'hide' | 'disable';
  readonly fullTone: 'info' | 'attention';
  readonly cell: (id: string, row: Row, context: Context) => ReactNode;
}

function ProductLink({
  product,
  gone,
}: {
  readonly product: OwnSuggestion['product'];
  readonly gone: string;
}) {
  return product.productCode === null ? (
    <>{gone}</>
  ) : (
    <a className="text-link underline" href={`/products/${product.id}`}>
      {product.name ?? product.productCode}
    </a>
  );
}

function StatusBadge({ status, t }: { readonly status: string; readonly t: Translate }) {
  const value = known(status, SUGGESTION_STATUSES);
  return <Badge tone={TONE[value] ?? 'neutral'}>{t(`status.${value}`)}</Badge>;
}

const VALUE_KIND: Kind<OwnSuggestion> = {
  ns: 'catalog.suggestions',
  endpoint: 'catalog/seller/attribute-suggestions',
  newHref: '/value-suggestions/new',
  columns: ['field', 'product', 'status', 'outcome', 'sent'],
  counterKey: 'waiting',
  fullButton: 'hide',
  fullTone: 'info',
  cell: (id, item, { t, defaultLocale, locale, timeZone }) => {
    switch (id) {
      case 'field':
        return item.attribute === null
          ? t('field-gone')
          : pickLabel(item.attribute.names, defaultLocale, item.attribute.code);
      case 'product':
        return <ProductLink product={item.product} gone={t('product-gone')} />;
      case 'status':
        return <StatusBadge status={item.status} t={t} />;
      case 'outcome': {
        const status = known(item.status, SUGGESTION_STATUSES);
        const value =
          item.value === null ? null : pickLabel(item.value.labels, defaultLocale, item.value.code);
        if (status === 'approved' && value !== null) return t('outcome.approved', { value });
        if (status === 'mapped' && value !== null) return t('outcome.mapped', { value });
        if (status === 'rejected') {
          return item.rejectReason === null || item.rejectReason === ''
            ? t('outcome.rejected')
            : t('outcome.rejected-reason', { reason: item.rejectReason });
        }
        return status === 'open' ? t('outcome.open') : '';
      }
      default:
        return formatInstant(item.createdAt, locale, timeZone);
    }
  },
};

const TAG_KIND: Kind<OwnTopicSuggestion> = {
  ns: 'catalog.tagSuggestions',
  endpoint: 'catalog/seller/topic-suggestions',
  newHref: '/tag-suggestions/new',
  columns: ['product', 'status', 'outcome', 'sent'],
  counterKey: 'used',
  fullButton: 'disable',
  fullTone: 'attention',
  cell: (id, item, { t, defaultLocale, locale, timeZone }) => {
    switch (id) {
      case 'product':
        return <ProductLink product={item.product} gone={t('product-gone')} />;
      case 'status':
        return <StatusBadge status={item.status} t={t} />;
      case 'outcome': {
        const status = known(item.status, SUGGESTION_STATUSES);
        const name =
          item.topic === null ? null : pickLabel(item.topic.names, defaultLocale, item.topic.slug);
        const decided = (status === 'approved' || status === 'mapped') && name !== null;
        const text = decided
          ? t(status === 'approved' ? 'outcome.approved' : 'outcome.mapped', { name })
          : status === 'rejected'
            ? item.rejectReason === null || item.rejectReason === ''
              ? t('outcome.rejected')
              : t('outcome.rejected-reason', { reason: item.rejectReason })
            : status === 'open'
              ? t('outcome.open')
              : '';
        return (
          <>
            <p>{text}</p>
            {decided ? (
              <p className="mt-1 text-sm text-fg-muted">
                {item.topic?.status === 'archived' ? t('outcome.retired') : t('outcome.add-it')}
                {item.topic?.status !== 'archived' && item.product.productCode !== null ? (
                  <>
                    {' '}
                    <a className="text-link underline" href={`/products/${item.product.id}`}>
                      {t('outcome.open-product')}
                    </a>
                  </>
                ) : null}
              </p>
            ) : null}
          </>
        );
      }
      default:
        return formatInstant(item.createdAt, locale, timeZone);
    }
  },
};

interface Props {
  readonly paging: 'pages' | 'prev-next';
  readonly accountId: string;
  readonly marketId: string;
  readonly timeZone: string | null;
  readonly canSuggest: boolean;
  /** The "Suggestion sent" banner of the page after a send. */
  readonly sent: boolean;
}

function OwnSuggestionsList<Row extends { readonly id: string; readonly label: string }>({
  kind,
  paging,
  accountId,
  marketId,
  timeZone,
  canSuggest,
  sent,
}: Props & { readonly kind: Kind<Row> }) {
  const t = useTranslations(kind.ns) as unknown as Translate;
  const tl = useTranslations(`${kind.ns}.list`) as unknown as Translate;
  const locale = useLocale();
  const [counts, setCounts] = useState<{ open: number; max: number } | null>(null);
  const [seen, setSeen] = useState(false);
  // The default locale rides in a ref: a state would change the config and read the list again.
  const defaultLocale = useRef('en');

  const columnDefs = useCallback(
    (id: string, header: string): SuperColumn<Row> => {
      if (id === 'label') {
        return {
          id,
          header,
          primary: true,
          cell: (row) => <span className="font-medium wrap-anywhere text-fg">{row.label}</span>,
        };
      }
      return {
        id,
        header,
        ...(id === 'sent' ? { skeleton: 'date' as const } : {}),
        cell: (row) => (
          <span className="wrap-anywhere">
            {kind.cell(id, row, { t, defaultLocale: defaultLocale.current, locale, timeZone })}
          </span>
        ),
      };
    },
    [kind, t, locale, timeZone],
  );

  const config: PagedListConfig<Row> = useMemo(
    () => ({
      ns: `${kind.ns}.list`,
      endpoint: kind.endpoint,
      rowId: (row) => row.id,
      rowName: (row) => row.label,
      tabs: ['all', ...SUGGESTION_STATUSES],
      tabParam: 'status',
      search: { max: 100 },
      sorts: [
        {
          id: 'created',
          orders: [tl('sort.date.first'), tl('sort.date.second')],
          defaultDirection: 'desc',
        },
        {
          id: 'status',
          orders: [tl('sort.text.first'), tl('sort.text.second')],
          defaultDirection: 'asc',
        },
        {
          id: 'label',
          orders: [tl('sort.text.first'), tl('sort.text.second')],
          defaultDirection: 'asc',
        },
      ],
      defaultSort: 'created',
      fixedColumns: ['label'],
      optionalColumns: kind.columns,
      defaultColumns: kind.columns,
      columnDefs,
      rowActions: () => [],
      readOnly: true,
      icon: 'package',
    }),
    [kind, tl, columnDefs],
  );

  const onAnswer = useCallback((answer: PagedAnswer<Row>) => {
    const whole = answer as unknown as {
      readonly openCount: number;
      readonly maxOpen: number;
      readonly locales: { readonly default: string };
    };
    defaultLocale.current = whole.locales.default;
    setCounts({ open: whole.openCount, max: whole.maxOpen });
    if (answer.items.length > 0) setSeen(true);
  }, []);

  const full = counts !== null && counts.open >= counts.max;
  const label = t('new.start');
  const button = !canSuggest ? null : full ? (
    kind.fullButton === 'hide' ? null : (
      <Button type="button" disabled aria-describedby="suggestion-limit">
        {label}
      </Button>
    )
  ) : (
    <LinkButton href={kind.newHref}>{label}</LinkButton>
  );

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h1 className="text-2xl font-semibold">{t('title')}</h1>
        {button}
      </div>
      {sent ? <Banner tone="success">{t('sent')}</Banner> : null}
      {counts !== null && (seen || counts.open > 0) ? (
        <p className="text-sm text-fg-muted" data-testid="open-count">
          {t(kind.counterKey, { count: counts.open, max: counts.max })}
        </p>
      ) : null}
      {full ? (
        <div id="suggestion-limit">
          <Banner tone={kind.fullTone}>{t('full', { max: counts.max })}</Banner>
        </div>
      ) : null}
      <PagedSuperList<Row>
        config={config}
        paging={paging}
        accountId={accountId}
        marketId={marketId}
        onAnswer={onAnswer}
      />
    </div>
  );
}

/** The seller's value suggestions as a super list (phase 2, list 34). */
export function OwnValueSuggestionsList(props: Props) {
  return <OwnSuggestionsList<OwnSuggestion> kind={VALUE_KIND} {...props} />;
}

/** The seller's tag suggestions as a super list (phase 2, list 35). */
export function OwnTagSuggestionsList(props: Props) {
  return <OwnSuggestionsList<OwnTopicSuggestion> kind={TAG_KIND} {...props} />;
}
