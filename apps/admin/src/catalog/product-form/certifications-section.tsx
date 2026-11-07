'use client';

import {
  Badge,
  Banner,
  Button,
  Card,
  EmptyState,
  Icon,
  LoadError,
  Menu,
  SkeletonRows,
  type MenuItem,
} from '@mondapac/ui';
import { useLocale, useTranslations } from 'next-intl';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { callApi } from '../../api/client.ts';
import { CertificateDialog, type CertDialogMode } from './certificate-dialog.tsx';
import { useCertificateDetails } from './certificate-details.tsx';
import {
  CERT_BASE,
  CERT_EDIT_PERMISSION,
  CERT_LIST_MAX,
  CERT_TYPE_VIEW_PERMISSION,
  CERT_VIEW_PERMISSION,
  categoryNameOf,
  coverageCount,
  formatDay,
  isInForce,
  joinWords,
  languageNames,
  publishedTitle,
  publishedVariants,
  reasonKey,
  statusOf,
  type CertList,
  type CertListItem,
} from './certificate-types.ts';
import { readable, type ProductView } from './types.ts';

type ListPhase =
  | { readonly kind: 'loading' }
  | { readonly kind: 'failed' }
  | { readonly kind: 'ready'; readonly items: readonly CertListItem[] };

const typeNameOf = (item: CertListItem): string => item.typeName ?? readable(item.typeCode);

// The card's own breakpoint is its width, not the screen's: a table from 640 px, a stacked list
// below (the page layout decides how wide the card is). Class names are written out in full so
// the stylesheet scan finds them.
const TABLE = 'w-full text-start text-sm @max-[639px]:block @min-[640px]:table-fixed';
const HEAD = 'bg-muted text-fg-muted @max-[639px]:sr-only';
const BODY = 'divide-y divide-line-row @max-[639px]:block';
const ROW =
  '@max-[639px]:grid @max-[639px]:min-h-[72px] @max-[639px]:grid-cols-[auto_minmax(0,1fr)_auto] @max-[639px]:px-4 @max-[639px]:py-3';
const CELL_CERT =
  'px-5 py-3 align-middle @max-[639px]:col-span-2 @max-[639px]:row-start-1 @max-[639px]:p-0';
const CELL_EXPIRES =
  'px-3 py-3 align-middle text-sm @max-[639px]:col-start-1 @max-[639px]:row-start-3 @max-[639px]:mt-2 @max-[639px]:p-0 @max-[639px]:before:me-1 @max-[639px]:before:text-fg-muted @max-[639px]:before:content-[attr(data-label)]';
const CELL_COVERS =
  "px-3 py-3 align-middle text-sm text-fg-secondary @max-[639px]:col-start-2 @max-[639px]:row-start-3 @max-[639px]:mt-2 @max-[639px]:p-0 @max-[639px]:before:mx-2 @max-[639px]:before:text-fg-muted @max-[639px]:before:content-['·']";
const CELL_STATUS =
  'px-3 py-3 align-middle @max-[639px]:col-span-3 @max-[639px]:row-start-2 @max-[639px]:mt-2 @max-[639px]:p-0';
const CELL_MENU =
  'p-0 align-middle @max-[639px]:col-start-3 @max-[639px]:row-start-1 @max-[639px]:justify-self-end';

export interface CertificationsSectionProps {
  readonly product: ProductView;
  readonly csrfToken: string;
  readonly permissionKeys: readonly string[];
  readonly marketName: string;
  /** The product was published in this session: its published revision is not read yet. */
  readonly justPublished: boolean;
  readonly onReload: () => void;
}

/**
 * "Product certifications" (ADR-0012): the certificates the manufacturer holds for this exact
 * product, with Add, Finish and send, and View details. It saves on its own: nothing here is part
 * of "Save revision", and the unsaved-changes guard never sees it. Hidden without the view key; Add
 * and Finish need the edit key and are absent, not disabled, without it.
 */
export function CertificationsSection({
  product,
  csrfToken,
  permissionKeys,
  marketName,
  justPublished,
  onReload,
}: CertificationsSectionProps) {
  const t = useTranslations('catalog.productForm.certs');
  const locale = useLocale();
  const canView = permissionKeys.includes(CERT_VIEW_PERMISSION);
  const canEdit = permissionKeys.includes(CERT_EDIT_PERMISSION);
  const canViewTypes = permissionKeys.includes(CERT_TYPE_VIEW_PERMISSION);
  const hasPublished = product.published !== null;

  const [phase, setPhase] = useState<ListPhase>({ kind: 'loading' });
  const [dialog, setDialog] = useState<{
    readonly key: number;
    readonly mode: CertDialogMode;
    readonly open: boolean;
  } | null>(null);
  const [live, setLive] = useState('');
  const addRef = useRef<HTMLButtonElement>(null);
  const opened = useRef(0);

  const variants = useMemo(() => publishedVariants(product), [product]);
  const details = useCertificateDetails(variants);

  const load = useCallback(async () => {
    const result = await callApi<CertList>('GET', `${CERT_BASE}/for-product/${product.productId}`);
    if (result.ok) {
      const items = (result.body as Partial<CertList> | null)?.items;
      setPhase(Array.isArray(items) ? { kind: 'ready', items } : { kind: 'failed' });
    } else if (result.failure.status === 401) window.location.assign('/session-ended');
    else setPhase({ kind: 'failed' });
  }, [product.productId]);

  useEffect(() => {
    if (canView && hasPublished) void load();
  }, [canView, hasPublished, load]);

  if (!canView) return null;

  if (!hasPublished) {
    return (
      <Card title={t('title')}>
        <p className="text-sm text-fg-secondary">
          {t(justPublished ? 'just-published' : 'publish-first')}
        </p>
        {justPublished ? (
          <div>
            <Button variant="secondary" onClick={onReload}>
              {t('retry')}
            </Button>
          </div>
        ) : null}
      </Card>
    );
  }

  const today = new Date();
  const items = phase.kind === 'ready' ? phase.items : [];

  function openDialog(mode: CertDialogMode): void {
    opened.current += 1;
    setDialog({ key: opened.current, mode, open: true });
  }

  // ---- The banners: rejected first (Critical), then expired and missing names (Attention).
  const rejected = items.filter(
    (item) =>
      item.status === 'rejected' &&
      !items.some(
        (other) =>
          other.typeId === item.typeId &&
          (other.status === 'draft' || other.status === 'in-review') &&
          other.lastChangedAt > item.lastChangedAt,
      ),
  );
  const expiredTypes = new Map<string, CertListItem>();
  for (const item of items) {
    if (statusOf(item, today).kind !== 'expired') continue;
    if (items.some((other) => other.typeId === item.typeId && isInForce(other, today))) continue;
    const seen = expiredTypes.get(item.typeId);
    if (seen === undefined || (item.expiryDate ?? '') > (seen.expiryDate ?? '')) {
      expiredTypes.set(item.typeId, item);
    }
  }
  const missingNames = new Map<string, { item: CertListItem; locales: Set<string> }>();
  for (const item of items) {
    if (item.typeNamesMissing.length === 0) continue;
    const entry = missingNames.get(item.typeId) ?? { item, locales: new Set<string>() };
    item.typeNamesMissing.forEach((locale) => entry.locales.add(locale));
    missingNames.set(item.typeId, entry);
  }

  const addButton = canEdit ? (
    <Button
      ref={addRef}
      variant="secondary"
      className="@max-[26rem]:w-full"
      onClick={() => openDialog({ kind: 'new' })}
    >
      <Icon name="plus" className="me-2" />
      {t('add')}
    </Button>
  ) : null;

  const category = categoryNameOf(product);

  return (
    <>
      <div className="@container">
        <Card>
          <div className="flex flex-wrap items-center justify-between gap-3">
            <h2 className="text-lg font-semibold text-fg">{t('title')}</h2>
            {addButton}
          </div>
          <p className="text-sm text-fg-secondary">{t('helper')}</p>
          {rejected.map((item) => (
            <Banner
              key={item.id}
              tone="critical"
              title={t('banner.rejected.title', { type: typeNameOf(item) })}
            >
              <p>
                {t('banner.rejected.body', {
                  reason: t(`reason.${reasonKey(item.rejectionReasonCode)}`),
                })}
              </p>
              <Button variant="link" onClick={() => details.open(item)}>
                {t('banner.view')}
              </Button>
            </Banner>
          ))}
          {[...expiredTypes.values()].map((item) => (
            <Banner
              key={item.typeId}
              tone="attention"
              title={t('banner.expired.title', {
                type: typeNameOf(item),
                date: formatDay(item.expiryDate, locale, false),
              })}
            >
              <p>{t('banner.expired.body', { type: typeNameOf(item) })}</p>
              {canEdit ? (
                <Button variant="link" onClick={() => openDialog({ kind: 'new' })}>
                  {t('add')}
                </Button>
              ) : null}
            </Banner>
          ))}
          {[...missingNames.values()].map(({ item, locales }) => {
            const words = languageNames([...locales]);
            return (
              <Banner
                key={item.typeId}
                tone="attention"
                title={t('banner.words.title', {
                  languages: joinWords(words, 'conjunction'),
                  type: typeNameOf(item),
                })}
              >
                <p>
                  {t(canViewTypes ? 'banner.words.body' : 'banner.words.body-ask', {
                    languagesOr: joinWords(words, 'disjunction'),
                  })}
                </p>
              </Banner>
            );
          })}
          {phase.kind === 'loading' ? (
            <SkeletonRows label={t('loading')} rows={2} />
          ) : phase.kind === 'failed' ? (
            <LoadError
              message={t('load-failed')}
              retryLabel={t('retry')}
              onRetry={() => {
                setPhase({ kind: 'loading' });
                void load();
              }}
            />
          ) : items.length === 0 ? (
            <EmptyState
              size="card"
              icon="shield-check"
              title={t('empty.title')}
              body={t('empty.body')}
            />
          ) : (
            <CertTable
              items={items}
              variants={variants}
              today={today}
              locale={locale}
              canEdit={canEdit}
              onView={details.open}
              onFinish={(item) => openDialog({ kind: 'finish', item })}
            />
          )}
          {phase.kind === 'ready' && items.length >= CERT_LIST_MAX ? (
            <p className="text-sm text-fg-muted">{t('latest', { count: CERT_LIST_MAX })}</p>
          ) : null}
          <Banner tone="info" title={t('info.title')}>
            <p>{t('info.body', { category: category ?? t('info.category-fallback') })}</p>
          </Banner>
        </Card>
        <p role="status" className="sr-only">
          {live}
        </p>
      </div>
      {typeof document === 'undefined'
        ? null
        : createPortal(
            <>
              {dialog === null ? null : (
                <CertificateDialog
                  key={dialog.key}
                  open={dialog.open}
                  mode={dialog.mode}
                  productId={product.productId}
                  productTitle={publishedTitle(product)}
                  variants={variants}
                  csrfToken={csrfToken}
                  marketName={marketName}
                  onClose={() => setDialog((current) => current && { ...current, open: false })}
                  onCreated={() => void load()}
                  onSent={() => {
                    setDialog((current) => current && { ...current, open: false });
                    setLive(t('live.sent'));
                    void load();
                    setTimeout(() => addRef.current?.focus(), 0);
                  }}
                />
              )}
              {details.drawer}
            </>,
            document.body,
          )}
    </>
  );
}

function CertTable({
  items,
  variants,
  today,
  locale,
  canEdit,
  onView,
  onFinish,
}: {
  readonly items: readonly CertListItem[];
  readonly variants: Parameters<typeof coverageCount>[1];
  readonly today: Date;
  readonly locale: string;
  readonly canEdit: boolean;
  readonly onView: (item: CertListItem) => void;
  readonly onFinish: (item: CertListItem) => void;
}) {
  const t = useTranslations('catalog.productForm.certs');
  const th = `px-3 py-2 text-start font-medium`;
  return (
    <div className="-mx-5 overflow-x-auto border-y border-line">
      <table className={TABLE}>
        <caption className="sr-only">{t('table-caption')}</caption>
        <thead className={HEAD}>
          <tr>
            <th scope="col" className={`${th} px-5`}>
              {t('col.certificate')}
            </th>
            <th scope="col" className={`${th} w-[110px]`}>
              {t('col.expires')}
            </th>
            <th scope="col" className={`${th} w-[120px]`}>
              {t('col.covers')}
            </th>
            <th scope="col" className={`${th} w-[170px]`}>
              {t('col.status')}
            </th>
            <th scope="col" className={`${th} w-[56px] p-0`}>
              <span className="sr-only">{t('col.actions')}</span>
            </th>
          </tr>
        </thead>
        <tbody className={BODY}>
          {items.map((item) => {
            const status = statusOf(item, today);
            const covers = coverageCount(item, variants);
            const type = typeNameOf(item);
            const attention = status.kind === 'expiring' || status.kind === 'expired';
            const menu: MenuItem[] = [
              ...(item.status === 'draft' && canEdit
                ? [
                    {
                      id: 'finish',
                      label: t('menu.finish'),
                      icon: 'file' as const,
                      onSelect: () => onFinish(item),
                    },
                  ]
                : []),
              {
                id: 'view',
                label: t('menu.view'),
                icon: 'clipboard',
                onSelect: () => onView(item),
              },
            ];
            return (
              <tr
                key={item.id}
                className={`${status.kind === 'expiring' ? 'bg-attention-bg/40' : ''} ${ROW}`}
              >
                <td className={CELL_CERT}>
                  <span className="block break-words font-medium text-fg">{type}</span>
                  <span className="block break-words text-xs text-fg-muted">
                    {item.issuerName ?? t('issuer-unset')}
                  </span>
                </td>
                <td data-label={t('col.expires')} className={CELL_EXPIRES}>
                  <span className={attention ? 'text-attention-fg' : 'text-fg'}>
                    {formatDay(item.expiryDate, locale)}
                  </span>
                </td>
                <td className={CELL_COVERS}>
                  {covers.kind === 'whole'
                    ? variants.length <= 1
                      ? t('covers.whole')
                      : t('covers.all')
                    : t('covers.some', { count: covers.count, total: covers.of })}
                </td>
                <td className={CELL_STATUS}>
                  <div className="flex flex-col items-start gap-1">
                    <Badge tone={status.tone}>
                      {status.kind === 'expiring'
                        ? t('status.expiring', { days: status.days })
                        : t(`status.${status.kind}`)}
                    </Badge>
                    {status.kind === 'draft' && canEdit ? (
                      <Button variant="link" className="text-sm" onClick={() => onFinish(item)}>
                        {t('finish-link')}
                      </Button>
                    ) : null}
                  </div>
                </td>
                <td className={CELL_MENU}>
                  <div className="flex justify-center">
                    <Menu label={t('menu.label', { type })} items={menu} />
                  </div>
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
