'use client';

import { ActionRow, Banner, Button, Card, Dialog, TextAreaField, toast } from '@mondapac/ui';
import { useTranslations } from 'next-intl';
import { useRouter } from 'next/navigation';
import { useRef, useState } from 'react';
import { callApi, type ApiFailure } from '../api/client.ts';

/** The identity limit on a suspension reason (`MAX_ACCESS_REASON_LENGTH`). */
export const SUSPEND_REASON_MAX = 2000;

type Verb = 'suspend' | 'reinstate';

const BY_CODE: Readonly<Record<string, string>> = {
  'seller-access.wrong-state': 'wrong-state',
  'seller-access.reason-required': 'reason-required',
  'seller.unknown': 'not-found',
  'conflict.stale': 'retry',
  'conflict.retry': 'retry',
  'access.denied': 'denied',
  'request.csrf': 'csrf',
  'request.throttled': 'throttled',
};

export interface AccessProblem {
  /** The message key under `sellers.access.error`. */
  readonly key: string;
  /** The seller's state changed meanwhile: the page should be read again. */
  readonly reload: boolean;
  /** The reason field is the cause (empty, too long or a refused character). */
  readonly reasonInvalid: boolean;
}

/** What a refused suspend or lift says, by the API's code. */
export function accessProblemOf(failure: ApiFailure): AccessProblem {
  const reasonInvalid =
    failure.code === 'seller-access.reason-required' ||
    (failure.code === 'validation.failed' &&
      (failure.details?.fields ?? []).some((field) => field.path === 'reason'));
  const named = BY_CODE[failure.code];
  const key =
    named ??
    (reasonInvalid
      ? 'reason-invalid'
      : failure.code === 'validation.failed'
        ? 'invalid'
        : failure.status === 429
          ? 'throttled'
          : failure.status === 503 || failure.status === 0
            ? 'unavailable'
            : 'unknown');
  return { key, reload: key === 'wrong-state' || key === 'not-found', reasonInvalid };
}

/**
 * Suspend an approved seller with a reason for the Seller Owner, or lift a suspension (identity
 * SEL-07; identity ux D5 and D3). The card shows only to a holder of `identity.seller-access.suspend`
 * and only in the two states where one of the actions applies; the API checks both again.
 */
export function SellerAccessCard({
  sellerId,
  access,
  csrfToken,
}: {
  readonly sellerId: string;
  /** The seller's identity state: `approved` offers Suspend, `suspended` offers Lift. */
  readonly access: 'approved' | 'suspended';
  readonly csrfToken: string;
}) {
  const t = useTranslations('sellers.access');
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [reason, setReason] = useState('');
  const [pending, setPending] = useState(false);
  const [problem, setProblem] = useState<AccessProblem | null>(null);
  const busy = useRef(false);
  const verb: Verb = access === 'approved' ? 'suspend' : 'reinstate';
  const reasonEmpty = reason.trim() === '';

  function close() {
    if (pending) return;
    setOpen(false);
    setProblem(null);
  }

  async function send() {
    if (busy.current) return;
    if (verb === 'suspend' && reasonEmpty) {
      setProblem({ key: 'reason-required', reload: false, reasonInvalid: true });
      return;
    }
    busy.current = true;
    setPending(true);
    setProblem(null);
    const result = await callApi<unknown>(
      'POST',
      `identity/admin/sellers/${sellerId}/${verb}`,
      verb === 'suspend' ? { reason: reason.trim() } : {},
      csrfToken,
    );
    busy.current = false;
    setPending(false);
    if (result.ok) {
      setOpen(false);
      setReason('');
      toast.success(t(`toast.${verb}`));
      router.refresh();
      return;
    }
    if (result.failure.status === 401) {
      window.location.assign('/session-ended');
      return;
    }
    setProblem(accessProblemOf(result.failure));
  }

  const fieldError = problem?.reasonInvalid === true ? t(`error.${problem.key}`) : undefined;
  return (
    <Card title={t('title')}>
      <p className="text-fg-secondary">{t(`intro.${access}`)}</p>
      <ActionRow>
        <Button
          variant={verb === 'suspend' ? 'destructive' : 'secondary'}
          onClick={() => {
            setProblem(null);
            setOpen(true);
          }}
        >
          {t(`action.${verb}`)}
        </Button>
      </ActionRow>
      <Dialog
        open={open}
        title={t(`dialog.${verb}.title`)}
        onClose={close}
        actions={
          <>
            <Button variant="secondary" disabled={pending} onClick={close}>
              {t('cancel')}
            </Button>
            <Button
              variant={verb === 'suspend' ? 'destructive-solid' : 'primary'}
              loading={pending}
              onClick={() => void send()}
            >
              {t(`dialog.${verb}.action`)}
            </Button>
          </>
        }
      >
        <div className="flex flex-col gap-3">
          <p>{t(`dialog.${verb}.body`)}</p>
          {problem !== null && !problem.reasonInvalid ? (
            <Banner tone="critical">
              {t(`error.${problem.key}`)}
              {problem.reload ? (
                <>
                  {' '}
                  <Button variant="link" onClick={() => router.refresh()}>
                    {t('reload')}
                  </Button>
                </>
              ) : null}
            </Banner>
          ) : null}
          {verb === 'suspend' ? (
            <TextAreaField
              name="reason"
              label={t('dialog.suspend.reason')}
              help={t('dialog.suspend.reason-help')}
              value={reason}
              rows={4}
              maxLength={SUSPEND_REASON_MAX}
              counter={`${reason.length} / ${SUSPEND_REASON_MAX}`}
              error={fieldError}
              onChange={(event) => setReason(event.target.value)}
            />
          ) : null}
        </div>
      </Dialog>
    </Card>
  );
}
