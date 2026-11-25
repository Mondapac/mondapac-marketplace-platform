'use client';

import { Button, Dialog, Select } from '@mondapac/ui';
import { useTranslations } from 'next-intl';
import { useState } from 'react';
import {
  BulkDecideDialog,
  type BulkResult,
  type BulkRow,
} from '../shared/paged-list/bulk-decide-dialog.tsx';
import { PRODUCT_CHANGE_REASONS } from './version-review/types.ts';
import { CHANGE_REASONS } from './types.ts';

export type ReviewBulkKind = 'revision' | 'offer';
export type ReviewBulkAction = 'approve' | 'request-changes';
export interface ReviewBulk {
  readonly kind: ReviewBulkKind;
  readonly action: ReviewBulkAction;
  readonly rows: readonly BulkRow[];
  /**
   * An Offer approval the reviewer may not ask for (the Offer review queue checks it before the
   * server does): the dialog says why and offers no confirm.
   */
  readonly blocked?: { readonly why: 'reasons' | 'certificate-mixed'; readonly reasons: string };
  /** Offers with a certificate badge to check: who and which type, named in the confirmation. */
  readonly certificate?: { readonly seller: string; readonly type: string };
}

const API_BULK = 'catalog/admin/review-queue/bulk-decide';

/**
 * The bulk decision of the review queue (list 13 and 14): approve, or send back with one prepared
 * reason, the ticked rows of the page (at most 50). A bulk approve never ticks a manual check, so a
 * revision whose review needs checks is skipped by the API and told here, to be opened one by one.
 */
export function ReviewBulkDialog({
  bulk,
  csrfToken,
  onClose,
  onFinished,
}: {
  readonly bulk: ReviewBulk | null;
  readonly csrfToken: string;
  readonly onClose: () => void;
  readonly onFinished: () => void;
}) {
  if (bulk === null) return null;
  return (
    <Inner
      key={`${bulk.kind}-${bulk.action}`}
      bulk={bulk}
      csrfToken={csrfToken}
      onClose={onClose}
      onFinished={onFinished}
    />
  );
}

function Inner({
  bulk,
  csrfToken,
  onClose,
  onFinished,
}: {
  readonly bulk: ReviewBulk;
  readonly csrfToken: string;
  readonly onClose: () => void;
  readonly onFinished: () => void;
}) {
  const t = useTranslations('catalog.queue.bulk');
  const tr = useTranslations('catalog.version.decision');
  const to = useTranslations('catalog.review');
  const [reason, setReason] = useState('');
  const sendBack = bulk.action === 'request-changes';
  const count = bulk.rows.length;
  const reasons = bulk.kind === 'revision' ? PRODUCT_CHANGE_REASONS : CHANGE_REASONS;
  const tq = useTranslations('offer-review.bulk');
  const tReason = useTranslations('offer-review.reason');
  const tc = useTranslations('bulk-decide');
  if (bulk.blocked !== undefined) {
    return (
      <Dialog
        open
        size="form"
        title={tq('blocked.title')}
        onClose={onClose}
        actions={<Button onClick={onClose}>{tc('close')}</Button>}
      >
        <p role="status" className="wrap-anywhere">
          {bulk.blocked.why === 'reasons'
            ? tq('blocked.reasons', { reasons: bulk.blocked.reasons })
            : tq('blocked.certificate-mixed')}
        </p>
      </Dialog>
    );
  }
  const skippedLine = (entry: BulkResult): string | null => {
    const name = entry.name ?? entry.id;
    switch (entry.reason) {
      case 'review.bulk-not-allowed':
        return tq('skipped.not-allowed', {
          name,
          reasons: (entry.blockers ?? [])
            .map((code) => (tReason.has(code) ? tReason(code) : code))
            .join(', '),
        });
      case 'review.bulk-certificate-mixed':
        return tq('skipped.certificate-mixed', { name });
      case 'review.reasons-unknown':
        return tq('skipped.reasons-unknown', { name });
      default:
        return null;
    }
  };
  return (
    <BulkDecideDialog
      endpoint={API_BULK}
      action={bulk.action}
      rows={bulk.rows}
      toItem={(row) =>
        bulk.kind === 'revision'
          ? { id: row.id, revisionId: row.revisionId, version: row.version }
          : { id: row.id, version: row.version }
      }
      title={t(`${bulk.action}.title.${bulk.kind}`, { count })}
      body={
        bulk.certificate === undefined
          ? t(`${bulk.action}.${bulk.kind}`, { count })
          : `${t(`${bulk.action}.${bulk.kind}`, { count })} ${tq('certificate', bulk.certificate)}`
      }
      confirm={t(`${bulk.action}.confirm.${bulk.kind}`, { count })}
      ready={!sendBack || reason !== ''}
      extraBody={{ kind: bulk.kind, ...(sendBack ? { reasonCode: reason } : {}) }}
      describeSkipped={bulk.kind === 'offer' ? skippedLine : undefined}
      reasonText={(code, rows) =>
        code === 'review.checks-missing' ? t('checks-missing', { count: rows }) : null
      }
      csrfToken={csrfToken}
      fields={
        sendBack ? (
          <Select
            label={bulk.kind === 'revision' ? tr('reason') : to('reason.label')}
            placeholder={bulk.kind === 'revision' ? tr('reason-placeholder') : to('reason.choose')}
            value={reason}
            required
            onChange={(event) => setReason(event.target.value)}
            options={reasons.map((code) => ({
              value: code,
              label: bulk.kind === 'revision' ? tr(`reason-code.${code}`) : to(`reason.${code}`),
            }))}
          />
        ) : null
      }
      onClose={onClose}
      onFinished={onFinished}
    />
  );
}
