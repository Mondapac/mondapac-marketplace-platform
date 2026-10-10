'use client';

import { Banner, Button, Select, TextField } from '@mondapac/ui';
import { useTranslations } from 'next-intl';
import { useRouter } from 'next/navigation';
import { useRef, useState, type FormEvent } from 'react';
import { callApi } from '../api/client.ts';
import { decisionProblemOf, type DecisionProblem } from './decision-errors.ts';
import { formatInstant } from './format.ts';
import type { ReviewRegister } from './review-types.ts';

const OUTCOMES = ['active', 'not-found', 'cancelled'] as const;
const REASON_MAX = 2000;

type Step = 'idle' | 'confirm-approve' | 'reject';
type Notice = 'approved' | 'rejected' | 'settling' | 'checked' | null;

/**
 * Approve, reject and the manual register check of a pending seller application. The buttons act
 * on the revision the page was rendered with; the API refuses a decision on a newer one
 * (`review.not-current-revision`), and every answer re-reads the page.
 */
export function DecisionPanel({
  sellerId,
  revisionId,
  register,
  decisionInProgress,
  canDecide,
  canCheck,
  csrfToken,
}: {
  readonly sellerId: string;
  readonly revisionId: string;
  readonly register: ReviewRegister;
  readonly decisionInProgress: boolean;
  readonly canDecide: boolean;
  readonly canCheck: boolean;
  readonly csrfToken: string;
}) {
  const t = useTranslations();
  const router = useRouter();
  const [step, setStep] = useState<Step>('idle');
  const [reason, setReason] = useState('');
  const [outcome, setOutcome] = useState('');
  const [pending, setPending] = useState(false);
  const [problem, setProblem] = useState<DecisionProblem | null>(null);
  const [notice, setNotice] = useState<Notice>(null);
  const busy = useRef(false);

  const locked = pending || decisionInProgress;
  const base = `sellers/admin/${sellerId}/review`;

  async function send(
    method: 'POST' | 'PUT',
    path: string,
    body: unknown,
    done: (status: number) => Notice,
  ): Promise<void> {
    if (busy.current) return;
    busy.current = true;
    setPending(true);
    setProblem(null);
    setNotice(null);
    const result = await callApi<unknown>(method, path, body, csrfToken);
    busy.current = false;
    setPending(false);
    if (result.ok) {
      setNotice(done(result.status));
      setStep('idle');
      setReason('');
      router.refresh();
      return;
    }
    if (result.failure.status === 401) {
      window.location.assign('/session-ended');
      return;
    }
    setProblem(decisionProblemOf(result.failure));
  }

  function recordCheck(event: FormEvent) {
    event.preventDefault();
    if (outcome === '') return;
    void send(
      'PUT',
      `${base}/manual-register-check`,
      { revisionId, observedOutcome: outcome },
      () => 'checked',
    );
  }

  function reject(event: FormEvent) {
    event.preventDefault();
    void send('POST', `${base}/reject`, { revisionId, reason: reason.trim() }, (status) =>
      status === 202 ? 'settling' : 'rejected',
    );
  }

  const check = register.manualCheck;
  return (
    <section className="flex flex-col gap-4 rounded-lg border border-line p-4">
      <h2 className="text-lg font-semibold">{t('sellers.decision.title')}</h2>
      {decisionInProgress ? <Banner tone="info">{t('sellers.decision.in-progress')}</Banner> : null}
      {notice === null ? null : (
        <Banner tone={notice === 'settling' ? 'info' : 'success'}>
          {t(`sellers.decision.notice.${notice}`)}
        </Banner>
      )}
      {problem === null ? null : (
        <Banner tone="critical">
          {t(problem.key)}
          {problem.reload ? (
            <>
              {' '}
              <Button variant="link" onClick={() => router.refresh()}>
                {t('sellers.decision.reload')}
              </Button>
            </>
          ) : null}
        </Banner>
      )}

      {canCheck ? (
        <form className="flex flex-col gap-3" onSubmit={recordCheck} noValidate>
          <h3 className="font-medium">{t('sellers.decision.check.title')}</h3>
          <p className="text-sm text-fg-muted">
            {check === null
              ? t('sellers.decision.check.none')
              : t('sellers.decision.check.recorded', {
                  outcome: t(`sellers.decision.check.outcome.${check.observedOutcome}`),
                  when: formatInstant(check.recordedAt),
                })}
          </p>
          <p className="text-sm text-fg-muted">{t('sellers.decision.check.help')}</p>
          <Select
            name="observedOutcome"
            label={t('sellers.decision.check.label')}
            value={outcome}
            placeholder={t('sellers.decision.choose')}
            options={OUTCOMES.map((value) => ({
              value,
              label: t(`sellers.decision.check.outcome.${value}`),
            }))}
            onChange={(event) => setOutcome(event.target.value)}
          />
          <div>
            <Button
              type="submit"
              variant="secondary"
              loading={pending}
              disabled={outcome === '' || locked}
            >
              {t('sellers.decision.check.save')}
            </Button>
          </div>
        </form>
      ) : null}

      {canDecide ? (
        <div className="flex flex-col gap-3">
          {register.blocksApproval ? (
            <Banner tone="attention">{t('sellers.decision.blocked')}</Banner>
          ) : null}
          {step === 'confirm-approve' ? (
            <div className="flex flex-col gap-3">
              <p>{t('sellers.decision.approve-confirm')}</p>
              <div className="flex gap-3">
                <Button
                  loading={pending}
                  disabled={locked}
                  onClick={() =>
                    void send('POST', `${base}/approve`, { revisionId }, (status) =>
                      status === 202 ? 'settling' : 'approved',
                    )
                  }
                >
                  {t('sellers.decision.approve-yes')}
                </Button>
                <Button variant="secondary" disabled={pending} onClick={() => setStep('idle')}>
                  {t('sellers.decision.cancel')}
                </Button>
              </div>
            </div>
          ) : null}
          {step === 'reject' ? (
            <form className="flex flex-col gap-3" onSubmit={reject} noValidate>
              <TextField
                name="reason"
                label={t('sellers.decision.reason')}
                help={t('sellers.decision.reason-help')}
                value={reason}
                maxLength={REASON_MAX}
                error={
                  problem?.reasonInvalid === true ? t('sellers.decision.reason-invalid') : undefined
                }
                onChange={(event) => setReason(event.target.value)}
              />
              <div className="flex gap-3">
                <Button
                  type="submit"
                  variant="destructive"
                  loading={pending}
                  disabled={locked || reason.trim() === ''}
                >
                  {t('sellers.decision.reject-yes')}
                </Button>
                <Button variant="secondary" disabled={pending} onClick={() => setStep('idle')}>
                  {t('sellers.decision.cancel')}
                </Button>
              </div>
            </form>
          ) : null}
          {step === 'idle' ? (
            <div className="flex gap-3">
              <Button
                disabled={locked || register.blocksApproval}
                onClick={() => {
                  setProblem(null);
                  setNotice(null);
                  setStep('confirm-approve');
                }}
              >
                {t('sellers.decision.approve')}
              </Button>
              <Button
                variant="destructive"
                disabled={locked}
                onClick={() => {
                  setProblem(null);
                  setNotice(null);
                  setStep('reject');
                }}
              >
                {t('sellers.decision.reject')}
              </Button>
            </div>
          ) : null}
        </div>
      ) : null}
    </section>
  );
}
