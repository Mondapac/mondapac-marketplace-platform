'use client';

import {
  Badge,
  Button,
  Icon,
  relativeTime,
  SettingsHistoryDrawer,
  useSettingsHistory,
  type SettingsHistoryItem,
} from '@mondapac/ui';
import { useLocale, useTranslations } from 'next-intl';
import { useCallback, useEffect, useState, type ReactNode } from 'react';
import { callApi } from '../../api/client.ts';
import {
  CERT_BASE,
  coverageCount,
  fileSize,
  formatDay,
  mediaLabel,
  reasonKey,
  statusOf,
  type CertHistory,
  type CertHistoryEntry,
  type CertListItem,
  type CertRecord,
  type CertStatus,
  type PublishedVariant,
} from './certificate-types.ts';
import { readable } from './types.ts';

type Loaded =
  | { readonly kind: 'loading' }
  | { readonly kind: 'failed' }
  | { readonly kind: 'ready'; readonly record: CertRecord };

const STATUS_WORD: Readonly<Record<CertStatus, string>> = {
  draft: 'draft',
  'in-review': 'waiting',
  approved: 'approved',
  rejected: 'rejected',
  suspended: 'suspended',
  revoked: 'revoked',
  expired: 'expired',
};

/** Reviewers decide; the author only writes and sends. */
const DECISIONS: readonly CertStatus[] = ['approved', 'rejected', 'suspended', 'revoked'];

/**
 * The read-only details of one certificate, in the panel's history drawer (right side, full width
 * on a phone): the fields above, the status history below. The drawer is the one the settings pages
 * use; here it carries a details block as its `intro`. The number is never shown (only that it is
 * recorded) and the document has no link: only reviewers can open it.
 */
export function useCertificateDetails(
  variants: readonly PublishedVariant[],
  onClosed?: () => void,
) {
  const t = useTranslations('catalog.productForm.certs');
  const locale = useLocale();
  const [item, setItem] = useState<CertListItem | null>(null);
  const [loaded, setLoaded] = useState<Loaded>({ kind: 'loading' });
  const [author, setAuthor] = useState<string | null>(null);

  const id = item?.id ?? null;
  const read = useCallback(async () => {
    if (id === null) return;
    setLoaded({ kind: 'loading' });
    const result = await callApi<CertRecord>('GET', `${CERT_BASE}/${id}`);
    if (result.ok) {
      setLoaded({ kind: 'ready', record: result.body });
      setAuthor(result.body.author.accountId);
    } else {
      if (result.failure.status === 401) window.location.assign('/session-ended');
      setLoaded({ kind: 'failed' });
    }
  }, [id]);
  useEffect(() => {
    void read();
  }, [read]);

  const load = useCallback(
    async (after: string | null) => {
      if (id === null || after !== null) return null;
      const result = await callApi<CertHistory>('GET', `${CERT_BASE}/${id}/history`);
      if (!result.ok) {
        if (result.failure.status === 401) window.location.assign('/session-ended');
        return null;
      }
      const entries: readonly CertHistoryEntry[] | undefined = (
        result.body as Partial<CertHistory> | null
      )?.entries;
      if (!Array.isArray(entries)) return null;
      return { items: entries as readonly CertHistoryEntry[], next: null };
    },
    [id],
  );
  const history = useSettingsHistory(load);

  const word = (status: CertStatus) => t(`status.${STATUS_WORD[status]}`);
  const items: SettingsHistoryItem[] = history.rows.map((entry) => {
    const who =
      entry.actor === null
        ? t('history.who-system')
        : DECISIONS.includes(entry.toStatus) && entry.actor.accountId !== author
          ? t('history.who-reviewer')
          : entry.actor.accountId === author
            ? t('history.who-author')
            : t('history.who-other');
    const moved =
      entry.fromStatus === null
        ? t('history.started', { to: word(entry.toStatus) })
        : t('history.moved', { from: word(entry.fromStatus), to: word(entry.toStatus) });
    const reason =
      entry.reasonCode === null
        ? ''
        : ` · ${t('history.reason', { reason: t(`reason.${reasonKey(entry.reasonCode)}`) })}`;
    return {
      id: entry.id,
      who,
      when: relativeTime(entry.occurredAt, locale),
      dateTime: entry.occurredAt,
      what: `${moved}${reason}`,
    };
  });

  const { show } = history;
  const open = useCallback(
    (next: CertListItem) => {
      setItem(next);
      setLoaded({ kind: 'loading' });
      show();
    },
    [show],
  );

  const intro =
    item === null ? null : (
      <div className="border-b border-line px-4 py-4 sm:px-6">
        {loaded.kind === 'loading' ? (
          <p role="status" className="text-sm text-fg-muted">
            {t('details.loading')}
          </p>
        ) : loaded.kind === 'failed' ? (
          <div role="alert" className="flex flex-col items-start gap-2">
            <p className="text-sm text-critical-fg">{t('details.error')}</p>
            <Button variant="secondary" onClick={() => void read()}>
              {t('details.retry')}
            </Button>
          </div>
        ) : (
          <Fields item={item} record={loaded.record} variants={variants} locale={locale} />
        )}
        <h3 className="mt-5 text-sm font-semibold text-fg">{t('details.history')}</h3>
      </div>
    );

  const drawer = (
    <SettingsHistoryDrawer
      open={history.open}
      onClose={() => {
        history.close();
        onClosed?.();
      }}
      onLoadMore={() => void history.more()}
      onRetry={() => void history.retry()}
      intro={intro}
      state={
        history.phase === 'loading'
          ? { kind: 'loading' }
          : history.phase === 'error'
            ? { kind: 'error' }
            : {
                kind: 'ready',
                items,
                hasMore: history.hasMore,
                loadingMore: history.loadingMore,
                moreFailed: history.moreFailed,
              }
      }
      labels={{
        title: t('details.title'),
        close: t('details.close'),
        loading: t('history.loading'),
        emptyTitle: t('history.empty-title'),
        emptyBody: t('history.empty-body'),
        error: t('history.error'),
        retry: t('history.retry'),
        loadMore: t('history.load-more'),
        moreFailed: t('history.more-failed'),
      }}
    />
  );
  return { open, drawer };
}

function Fields({
  item,
  record,
  variants,
  locale,
}: {
  readonly item: CertListItem;
  readonly record: CertRecord;
  readonly variants: readonly PublishedVariant[];
  readonly locale: string;
}) {
  const t = useTranslations('catalog.productForm.certs');
  // The newest revision that exists speaks for the record: approved, else pending, else the draft.
  const source = record.approved ?? record.pending;
  const manufacturer = source?.manufacturerName ?? record.draft.manufacturerName;
  const issued = source?.issueDate ?? record.draft.issueDate;
  const documents = source?.documents ?? record.draft.documents;
  const numberRecorded = record.draft.certificateNumberSet || source !== null;
  const status = statusOf(item, new Date());
  const covers = coverageCount(item, variants);
  const names =
    covers.kind === 'whole'
      ? null
      : variants.filter((variant) => item.coverage.variantIds.includes(variant.id));
  const document = documents[0];

  const row = (label: string, value: ReactNode) => (
    <div className="grid grid-cols-[minmax(0,7.5rem)_minmax(0,1fr)] gap-x-3 py-1.5 text-sm">
      <dt className="text-fg-muted">{label}</dt>
      <dd className="min-w-0 break-words text-fg">{value}</dd>
    </div>
  );
  const none = <span className="text-fg-muted">{t('details.none')}</span>;
  return (
    <dl>
      {row(
        t('details.field.status'),
        <Badge tone={status.tone}>
          {status.kind === 'expiring'
            ? t('status.expiring', { days: status.days })
            : t(`status.${status.kind}`)}
        </Badge>,
      )}
      {row(t('details.field.type'), item.typeName ?? readable(item.typeCode))}
      {row(t('details.field.issuer'), item.issuerName ?? none)}
      {row(t('details.field.manufacturer'), manufacturer ?? none)}
      {row(
        t('details.field.number'),
        numberRecorded ? (
          <span className="inline-flex items-center gap-1.5">
            <Icon name="check" className="text-success-fg" />
            {t('details.number-recorded')}
          </span>
        ) : (
          none
        ),
      )}
      {row(t('details.field.issued'), issued === null ? none : formatDay(issued, locale))}
      {row(
        t('details.field.expires'),
        item.expiryDate === null ? none : formatDay(item.expiryDate, locale),
      )}
      {row(
        t('details.field.covers'),
        names === null ? (
          variants.length <= 1 ? (
            t('covers.whole')
          ) : (
            t('covers.all')
          )
        ) : (
          <ul className="flex flex-col gap-0.5">
            {names.map((variant) => (
              <li key={variant.id}>{variant.label}</li>
            ))}
          </ul>
        ),
      )}
      {row(
        t('details.field.document'),
        document === undefined
          ? t('details.no-document')
          : t('details.document', {
              kind: mediaLabel(document.mediaType),
              size: fileSize(document.byteSize),
            }),
      )}
      {item.status === 'rejected'
        ? row(
            t('details.field.reason'),
            t(`reason.${reasonKey(item.rejectionReasonCode)}`).replace(/^./, (c) =>
              c.toUpperCase(),
            ),
          )
        : null}
    </dl>
  );
}
