'use client';

import {
  Button,
  ConfirmAction,
  Dialog,
  Select,
  TextAreaField,
  toast,
  type MenuItem,
} from '@mondapac/ui';
import { useTranslations } from 'next-intl';
import { useRouter } from 'next/navigation';
import { useRef, useState, type ReactNode } from 'react';
import { callApi } from '../api/client.ts';
import { reviewProblemOf } from './errors.ts';
import {
  REPORT_REASONS,
  type ReportReason,
  type SellerReview,
  type SellerReviewRow,
} from './types.ts';

type Step = 'reply' | 'edit' | 'report';
interface Pending {
  readonly step: Step;
  readonly row: SellerReviewRow;
}

/**
 * The Actions menu of a review row. The API names the actions a row has (open, reply, edit-reply,
 * report: the server decides per caller, review and session), so the menu never offers one the API
 * would refuse. Reply and Edit reply open a dialog with the text (one public reply, editable for
 * the Market's window); Report opens a dialog with the closed list of reasons (level 2: it names
 * the review and says nothing changes until a person looks). Returns the menu items of a row, the
 * dialogs (rendered once by the list), and the ids reported in this visit.
 */
export function useReviewRowActions(
  csrfToken: string,
  /** A review changed: the list reads its page again. */
  onChanged: () => void,
): {
  readonly items: (row: SellerReviewRow) => readonly MenuItem[];
  readonly dialogs: ReactNode;
  readonly reported: ReadonlySet<string>;
} {
  const t = useTranslations('reviews');
  const router = useRouter();
  const [pending, setPending] = useState<Pending | null>(null);
  const [text, setText] = useState('');
  const [reason, setReason] = useState<ReportReason>('abusive');
  const [problem, setProblem] = useState<string | null>(null);
  const [running, setRunning] = useState(false);
  const [reported, setReported] = useState<ReadonlySet<string>>(new Set());
  const busy = useRef(false);

  function open(step: Step, row: SellerReviewRow) {
    setProblem(null);
    setText(step === 'edit' && row.reply !== null ? row.reply.body : '');
    setReason('abusive');
    setPending({ step, row });
  }

  async function run(current: Pending) {
    if (busy.current) return;
    busy.current = true;
    setRunning(true);
    setProblem(null);
    const id = current.row.id;
    const result =
      current.step === 'report'
        ? await callApi<{ reported: true }>(
            'POST',
            `reviews/seller/${id}/report`,
            { reasonCode: reason },
            csrfToken,
          )
        : await callApi<SellerReview>(
            current.step === 'edit' ? 'PATCH' : 'POST',
            `reviews/seller/${id}/reply`,
            { body: text },
            csrfToken,
          );
    busy.current = false;
    setRunning(false);
    if (result.ok) {
      setPending(null);
      if (current.step === 'report') setReported((set) => new Set(set).add(id));
      toast.success(
        t(
          current.step === 'report'
            ? 'report.sent'
            : current.step === 'edit'
              ? 'reply.saved-edit'
              : 'reply.saved',
        ),
      );
      onChanged();
      return;
    }
    if (result.failure.status === 401) {
      window.location.assign('/session-ended');
      return;
    }
    setProblem(reviewProblemOf(result.failure));
  }

  const items = (row: SellerReviewRow): readonly MenuItem[] => {
    const has = (action: string) => (row.actions as readonly string[]).includes(action);
    const out: MenuItem[] = [];
    if (has('open')) {
      out.push({
        id: 'product',
        label: t('list.row-actions.product'),
        onSelect: () => router.push(`/products/${row.productId}`),
      });
      if (row.orderRef !== null) {
        const order = row.orderRef;
        out.push({
          id: 'order',
          label: t('list.row-actions.order'),
          onSelect: () => router.push(`/orders/${order}`),
        });
      }
    }
    if (has('reply')) {
      out.push({
        id: 'reply',
        label: t('list.row-actions.reply'),
        onSelect: () => open('reply', row),
      });
    }
    if (has('edit-reply')) {
      out.push({
        id: 'edit-reply',
        label: t('list.row-actions.edit-reply'),
        onSelect: () => open('edit', row),
      });
    }
    if (has('report') && !reported.has(row.id)) {
      out.push({
        id: 'report',
        label: t('list.row-actions.report'),
        tone: 'critical',
        onSelect: () => open('report', row),
      });
    }
    return out;
  };

  const writing = pending?.step === 'reply' || pending?.step === 'edit';
  const name =
    pending === null
      ? ''
      : (pending.row.title ?? t('list.untitled', { rating: pending.row.rating }));
  const dialogs = (
    <>
      <Dialog
        open={pending !== null && writing}
        size="form"
        title={t(pending?.step === 'edit' ? 'reply.dialog-edit' : 'reply.dialog-new')}
        onClose={() => {
          if (!running) setPending(null);
        }}
        actions={
          <>
            <Button variant="secondary" onClick={() => setPending(null)} disabled={running}>
              {t('cancel')}
            </Button>
            <Button
              variant="primary"
              loading={running}
              disabled={text.trim() === ''}
              onClick={() => {
                if (pending !== null) void run(pending);
              }}
            >
              {t(pending?.step === 'edit' ? 'reply.save-edit' : 'reply.save')}
            </Button>
          </>
        }
      >
        <div className="flex flex-col gap-3">
          <p className="text-sm text-fg-muted">{t('reply.about', { name })}</p>
          <TextAreaField
            label={t(pending?.step === 'edit' ? 'reply.edit-label' : 'reply.label')}
            help={t('reply.help')}
            value={text}
            onChange={(event) => setText(event.target.value)}
            disabled={running}
            error={problem === null ? undefined : t(`error.${problem}`)}
          />
        </div>
      </Dialog>
      <ConfirmAction
        open={pending !== null && !writing}
        level={2}
        title={t('report.title', { name })}
        body={
          <div className="flex flex-col gap-3">
            <p>{t('report.intro')}</p>
            <Select
              label={t('report.reason-label')}
              value={reason}
              disabled={running}
              onChange={(event) => setReason(event.target.value as ReportReason)}
              options={REPORT_REASONS.map((id) => ({
                value: id,
                label: t(`report.reason.${id}`),
              }))}
            />
          </div>
        }
        rowName={name}
        confirmLabel={t('report.send')}
        cancelLabel={t('cancel')}
        pending={running}
        error={problem === null ? null : t(`error.${problem}`)}
        onConfirm={() => {
          if (pending !== null) void run(pending);
        }}
        onCancel={() => setPending(null)}
      />
    </>
  );
  return { items, dialogs, reported };
}
