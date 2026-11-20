'use client';

import { Select } from '@mondapac/ui';
import { useTranslations } from 'next-intl';
import { useState } from 'react';
import { BulkDecideDialog, type BulkRow } from '../shared/paged-list/bulk-decide-dialog.tsx';
import { PRODUCT_CHANGE_REASONS } from './version-review/types.ts';
import { CHANGE_REASONS } from './types.ts';

export type ReviewBulkKind = 'revision' | 'offer';
export type ReviewBulkAction = 'approve' | 'request-changes';
export interface ReviewBulk {
  readonly kind: ReviewBulkKind;
  readonly action: ReviewBulkAction;
  readonly rows: readonly BulkRow[];
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
      body={t(`${bulk.action}.${bulk.kind}`, { count })}
      confirm={t(`${bulk.action}.confirm.${bulk.kind}`, { count })}
      ready={!sendBack || reason !== ''}
      extraBody={{ kind: bulk.kind, ...(sendBack ? { reasonCode: reason } : {}) }}
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
