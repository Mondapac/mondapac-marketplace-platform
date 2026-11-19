'use client';

import { Banner, Button, Dialog, Select, TextAreaField, toast } from '@mondapac/ui';
import { useTranslations } from 'next-intl';
import { useEffect, useRef, useState } from 'react';
import { callApi } from '../api/client.ts';
import { BY_CODE } from './request-errors.ts';
import { API_REQUESTS, describeOptions, type RequestDecided, type RequestItem } from './types.ts';

export type Decision = 'approve' | 'map' | 'decline';
const REASON_MAX = 300;

/**
 * The decision on one size request, opened from the row's Actions menu (confirmation level 2: it
 * names the request and what follows, the red button is not the focused one, and a decline needs a
 * reason the seller reads). A refused decision is told in the dialog; one that went stale closes
 * it and the list reads again, with the reason said above the list.
 */
export function RequestDecisionDialog({
  item,
  decision,
  csrfToken,
  onClose,
  onSettled,
}: {
  readonly item: RequestItem | null;
  readonly decision: Decision | null;
  readonly csrfToken: string;
  readonly onClose: () => void;
  /** The decision was made, or the request turned out stale (`why` names the error key). */
  readonly onSettled: (why?: string) => void;
}) {
  const t = useTranslations('variants.requests');
  const cancel = useRef<HTMLButtonElement>(null);
  const busy = useRef(false);
  const [variantId, setVariantId] = useState('');
  const [reason, setReason] = useState('');
  const [pending, setPending] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);

  useEffect(() => {
    setVariantId('');
    setReason('');
    setProblem(null);
  }, [item?.id, decision]);

  if (item === null || decision === null) return null;
  const asked = describeOptions(item.options);
  const ready =
    decision === 'approve' || (decision === 'map' ? variantId !== '' : reason.trim() !== '');

  async function submit() {
    if (busy.current || item === null || decision === null) return;
    busy.current = true;
    setPending(true);
    setProblem(null);
    const body =
      decision === 'map' ? { variantId } : decision === 'decline' ? { reason: reason.trim() } : {};
    const result = await callApi<RequestDecided>(
      'POST',
      `${API_REQUESTS}/${item.id}/${decision}`,
      { version: item.version, ...body },
      csrfToken,
    );
    busy.current = false;
    setPending(false);
    if (result.ok) {
      toast.success(t(`decided.${result.body.request.status}`));
      onSettled();
      return;
    }
    if (result.failure.status === 401) {
      window.location.assign('/session-ended');
      return;
    }
    const known = BY_CODE[result.failure.code];
    const next = known ?? {
      key: result.failure.status === 0 || result.failure.status >= 500 ? 'unavailable' : 'unknown',
      reload: false,
    };
    if (next.reload) onSettled(next.key);
    else setProblem(next.key);
  }

  return (
    <Dialog
      open
      size={decision === 'approve' ? 'default' : 'form'}
      title={t(`dialog.${decision}.title`)}
      onClose={() => {
        if (!pending) onClose();
      }}
      initialFocus={cancel}
      actions={
        <>
          <Button ref={cancel} variant="secondary" disabled={pending} onClick={onClose}>
            {t('cancel')}
          </Button>
          <Button
            variant="destructive-solid"
            loading={pending}
            disabled={!ready || pending}
            onClick={() => void submit()}
          >
            {t(`dialog.${decision}.confirm`)}
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-3">
        <p className="wrap-anywhere">{t(`dialog.${decision}.body`, { asked })}</p>
        {problem === null ? null : (
          <div role="alert">
            <Banner tone="critical">{t(`error.${problem}`)}</Banner>
          </div>
        )}
        {decision === 'map' ? (
          <Select
            label={t('map-to')}
            placeholder={t('map-choose')}
            value={variantId}
            options={item.existing.map((variant) => ({
              value: variant.variantId,
              label: describeOptions(variant.options) || `#${variant.variantNo}`,
            }))}
            onChange={(event) => setVariantId(event.target.value)}
          />
        ) : null}
        {decision === 'decline' ? (
          <TextAreaField
            name="reason"
            label={t('reason')}
            help={t('reason-help')}
            rows={3}
            value={reason}
            maxLength={REASON_MAX}
            dir="auto"
            counter={`${reason.length} / ${REASON_MAX}`}
            onChange={(event) => setReason(event.target.value)}
          />
        ) : null}
      </div>
    </Dialog>
  );
}
