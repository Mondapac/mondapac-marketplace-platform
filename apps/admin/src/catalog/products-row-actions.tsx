'use client';

import { ConfirmAction, toast, type MenuItem } from '@mondapac/ui';
import { useTranslations } from 'next-intl';
import { useRouter } from 'next/navigation';
import { useRef, useState, type ReactNode } from 'react';
import { isStepUpCancelled, useGuardedCall } from '../step-up/step-up.tsx';
import type { ProductRow } from './products-types.ts';

type Asking =
  | { readonly kind: 'pause'; readonly row: ProductRow }
  | {
      readonly kind: 'delete';
      readonly row: ProductRow;
      readonly preview:
        | { readonly state: 'loading' }
        | { readonly state: 'failed' }
        | {
            readonly state: 'ready';
            readonly offers: number;
            readonly confirm: number;
            readonly eligible: number;
          };
    };

interface BulkAnswer {
  readonly eligible: number;
  readonly confirmOfferCount: number;
  readonly affectedOfferCount: number;
  readonly counts: { readonly done: number; readonly skipped: number; readonly failed: number };
}

const BULK = 'catalog/admin/products/bulk';

/**
 * The Actions menu of a product row and the dialogs it opens. The server says which actions the
 * row offers (`row.actions`: open, edit, pause, resume, delete); the menu shows exactly those.
 * Open and Edit go to the page; Activate runs at once (level 1); Deactivate asks first (level 2);
 * Delete shows how many Offers end, from a dry run, and asks for the product code (level 3, with a
 * step-up code when the server wants one). Every action runs through the same endpoint as the
 * Bulk action menu, over this one product.
 */
export function useProductRowActions({
  csrfToken,
  onChanged,
}: {
  readonly csrfToken: string;
  /** An action changed the product: the list loads again. */
  readonly onChanged: () => void;
}): {
  readonly items: (row: ProductRow) => readonly MenuItem[];
  readonly dialogs: ReactNode;
} {
  const t = useTranslations('catalog.products');
  const router = useRouter();
  const call = useGuardedCall();
  const [asking, setAsking] = useState<Asking | null>(null);
  const [pending, setPending] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  // A ref, not only state: a second click must not start a second request before a render.
  const inFlight = useRef(false);
  // The latest dry run: an older answer must not fill a dialog opened since.
  const dryRun = useRef(0);

  const post = (action: string, id: string, extra: Record<string, unknown> = {}) =>
    call<BulkAnswer>('POST', BULK, { action, productIds: [id], ...extra }, csrfToken);

  async function run(action: 'pause' | 'resume' | 'delete', row: ProductRow, extra = {}) {
    if (inFlight.current) return;
    inFlight.current = true;
    setPending(true);
    setProblem(null);
    const result = await post(action, row.productId, extra);
    inFlight.current = false;
    setPending(false);
    if (isStepUpCancelled(result)) return;
    const name = row.name ?? row.productCode;
    if (!result.ok) {
      if (result.failure.status === 401) {
        router.replace('/session-ended');
        return;
      }
      const text =
        result.failure.code === 'retire.count-changed'
          ? t('row.count-changed')
          : result.failure.status === 403
            ? t('bulk.error.denied')
            : t('bulk.error.unavailable');
      if (result.failure.code === 'retire.count-changed' && asking?.kind === 'delete') {
        // The dialog reloads with the new count; the message stays so the change is not silent.
        void openDelete(row);
        setProblem(text);
      } else if (asking === null) toast.error(text);
      else setProblem(text);
      return;
    }
    setAsking(null);
    if (result.body.counts.done === 0) {
      toast.warning(t('row.nothing-changed', { name }));
    } else {
      toast.success(t(`row.done.${action}`, { name }));
    }
    onChanged();
  }

  async function openDelete(row: ProductRow) {
    const ticket = ++dryRun.current;
    setProblem(null);
    setAsking({ kind: 'delete', row, preview: { state: 'loading' } });
    const result = await post('delete', row.productId, { dryRun: true });
    if (ticket !== dryRun.current) return;
    setAsking((current) =>
      current === null || current.kind !== 'delete' || current.row.productId !== row.productId
        ? current
        : {
            ...current,
            preview: result.ok
              ? {
                  state: 'ready',
                  offers: result.body.affectedOfferCount,
                  confirm: result.body.confirmOfferCount,
                  eligible: result.body.eligible,
                }
              : { state: 'failed' },
          },
    );
  }

  const items = (row: ProductRow): readonly MenuItem[] => {
    const allowed = new Set(row.actions ?? []);
    const out: MenuItem[] = [];
    if (allowed.has('open'))
      out.push({
        id: 'open',
        label: t('row.menu.open'),
        onSelect: () => router.push(`/catalog/products/${row.productId}/edit`),
      });
    if (allowed.has('edit'))
      out.push({
        id: 'edit',
        label: t('row.menu.edit'),
        onSelect: () => router.push(`/catalog/products/${row.productId}/edit`),
      });
    if (allowed.has('resume'))
      out.push({
        id: 'resume',
        label: t('row.menu.resume'),
        icon: 'check',
        onSelect: () => void run('resume', row),
      });
    if (allowed.has('pause'))
      out.push({
        id: 'pause',
        label: t('row.menu.pause'),
        icon: 'ban',
        onSelect: () => {
          dryRun.current += 1;
          setProblem(null);
          setAsking({ kind: 'pause', row });
        },
      });
    if (allowed.has('delete'))
      out.push({
        id: 'delete',
        label: t('row.menu.delete'),
        icon: 'trash',
        tone: 'critical',
        onSelect: () => void openDelete(row),
      });
    return out;
  };

  const name = asking === null ? '' : (asking.row.name ?? asking.row.productCode);
  const preview = asking?.kind === 'delete' ? asking.preview : null;
  const dialogs = (
    <ConfirmAction
      open={asking !== null}
      level={asking?.kind === 'delete' ? 3 : 2}
      title={asking === null ? '' : t(`row.${asking.kind}.title`, { name })}
      body={
        asking === null ? null : asking.kind === 'pause' ? (
          <p>{t('bulk.pause.body')}</p>
        ) : preview?.state === 'ready' ? (
          <p>
            {preview.eligible === 0
              ? t('bulk.delete.none')
              : t('bulk.delete.body', { offers: preview.offers })}
          </p>
        ) : preview?.state === 'failed' ? (
          <p role="alert">{t('bulk.error.unavailable')}</p>
        ) : (
          <p>{t('bulk.delete.checking')}</p>
        )
      }
      rowName={asking?.row.productCode ?? ''}
      typeLabel={t('row.type-code')}
      stepUpNote={asking?.kind === 'delete' ? t('row.step-up-note') : undefined}
      confirmLabel={
        asking === null
          ? ''
          : t(asking.kind === 'pause' ? 'bulk.pause.confirm' : 'bulk.delete.confirm')
      }
      cancelLabel={t('bulk.cancel')}
      pending={pending}
      confirmDisabled={
        asking?.kind === 'delete' && !(preview?.state === 'ready' && preview.eligible > 0)
      }
      error={problem}
      onConfirm={() => {
        if (asking === null) return;
        if (asking.kind === 'pause') void run('pause', asking.row);
        else if (asking.preview.state === 'ready')
          void run('delete', asking.row, { confirmOfferCount: asking.preview.confirm });
      }}
      onCancel={() => {
        dryRun.current += 1;
        setAsking(null);
      }}
    />
  );
  return { items, dialogs };
}
