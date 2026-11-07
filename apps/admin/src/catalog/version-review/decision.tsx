'use client';

import { Banner, Button, CheckboxRow, Dialog, LinkButton, Select } from '@mondapac/ui';
import { useTranslations } from 'next-intl';
import { useRef, useState, type FormEvent } from 'react';
import { callApi } from '../../api/client.ts';
import { decisionProblemOf, type DecisionProblem } from './errors.ts';
import { PRODUCT_CHANGE_REASONS } from './types.ts';

export type Decided = 'approved' | 'sent-back';

/**
 * The decision on a pending version: a checkbox per required check (Approve stays disabled until
 * every one is ticked, and says so), and Send back with a required reason. Both name the version
 * the reviewer saw. Without catalog.product.approve the card is view only. After a decision a
 * banner offers the queue and the next version in it. On phones only the two buttons stick to the
 * bottom of the screen; the checks stay in the page.
 */
export function DecisionCard({
  productId,
  revisionId,
  version,
  requiredChecks,
  canDecide,
  csrfToken,
  nextHref,
}: {
  readonly productId: string;
  readonly revisionId: string;
  readonly version: number;
  readonly requiredChecks: readonly string[];
  readonly canDecide: boolean;
  readonly csrfToken: string;
  /** The next pending version of the queue, if any. */
  readonly nextHref: string | null;
}) {
  const t = useTranslations('catalog.version.decision');
  const te = useTranslations('catalog.version.error');
  const [ticked, setTicked] = useState<ReadonlySet<string>>(new Set());
  const [pending, setPending] = useState(false);
  const [problem, setProblem] = useState<DecisionProblem | null>(null);
  const [decided, setDecided] = useState<Decided | null>(null);
  const [sendBack, setSendBack] = useState<{ readonly reason: string } | null>(null);
  const busy = useRef(false);
  const base = `catalog/admin/products/${productId}/revisions/${revisionId}`;
  const allTicked = requiredChecks.every((code) => ticked.has(code));
  const noteId = `${revisionId}-approve-note`;

  async function send(action: 'approve' | 'request-changes', body: object): Promise<boolean> {
    if (busy.current) return false;
    busy.current = true;
    setPending(true);
    setProblem(null);
    const result = await callApi<unknown>('POST', `${base}/${action}`, body, csrfToken);
    busy.current = false;
    setPending(false);
    if (result.ok) {
      setDecided(action === 'approve' ? 'approved' : 'sent-back');
      setSendBack(null);
      return true;
    }
    if (result.failure.status === 401) {
      window.location.assign('/session-ended');
      return false;
    }
    const next = decisionProblemOf(result.failure);
    setProblem(next);
    // A refused claim is fixed by the seller: open Send back with that reason chosen.
    if (next === 'claim-text') setSendBack({ reason: 'description-claim' });
    return false;
  }

  if (decided !== null) {
    return (
      <section className="flex flex-col gap-3 rounded-lg border border-line bg-surface p-5">
        <h2 className="text-lg font-semibold">{t('title')}</h2>
        <Banner tone="success">{t(`done.${decided}`)}</Banner>
        <div className="flex flex-wrap gap-3">
          <LinkButton variant="secondary" href="/review">
            {t('back-to-queue')}
          </LinkButton>
          {nextHref === null ? null : <LinkButton href={nextHref}>{t('next')}</LinkButton>}
        </div>
      </section>
    );
  }

  if (!canDecide) {
    return (
      <section className="flex flex-col gap-3 rounded-lg border border-line bg-surface p-5">
        <h2 className="text-lg font-semibold">{t('title')}</h2>
        <p className="text-fg-muted">{t('view-only')}</p>
      </section>
    );
  }

  return (
    <section className="flex flex-col gap-4 rounded-lg border border-line bg-surface p-5">
      <h2 className="text-lg font-semibold">{t('title')}</h2>
      {problem === null ? null : (
        <Banner tone={problem === 'retry' ? 'attention' : 'critical'}>
          <span className="flex flex-col items-start gap-2">
            <span>{te(problem)}</span>
            {problem === 'stale' ? (
              <Button variant="secondary" onClick={() => window.location.reload()}>
                {t('reload')}
              </Button>
            ) : null}
          </span>
        </Banner>
      )}
      {requiredChecks.length === 0 ? (
        <p className="text-sm text-fg-muted">{t('no-checks')}</p>
      ) : (
        <fieldset className="flex flex-col gap-3">
          <legend className="mb-2 text-sm font-medium">{t('checks')}</legend>
          {requiredChecks.map((code) => (
            <CheckboxRow
              key={code}
              label={t(`check.${code}`)}
              checked={ticked.has(code)}
              disabled={pending}
              onChange={(event) =>
                setTicked((current) => {
                  const next = new Set(current);
                  if (event.target.checked) next.add(code);
                  else next.delete(code);
                  return next;
                })
              }
            />
          ))}
        </fieldset>
      )}
      <div className="flex flex-col gap-2 max-lg:sticky max-lg:bottom-0 max-lg:-mx-5 max-lg:-mb-5 max-lg:border-t max-lg:border-line max-lg:bg-surface max-lg:p-4">
        <div className="grid grid-cols-2 gap-3">
          <Button
            variant="secondary"
            className="min-h-12 lg:min-h-0"
            disabled={pending}
            onClick={() => setSendBack({ reason: '' })}
          >
            {t('send-back')}
          </Button>
          <Button
            className="min-h-12 lg:min-h-0"
            disabled={!allTicked}
            loading={pending}
            aria-describedby={allTicked ? undefined : noteId}
            onClick={() => void send('approve', { version, checksConfirmed: [...ticked] })}
          >
            {t('approve')}
          </Button>
        </div>
        {allTicked ? null : (
          <p id={noteId} className="text-sm text-fg-muted">
            {t('tick-all')}
          </p>
        )}
      </div>
      <SendBackDialog
        open={sendBack !== null}
        initialReason={sendBack?.reason ?? ''}
        pending={pending}
        problem={sendBack !== null && problem !== 'claim-text' ? problem : null}
        onClose={() => {
          if (!busy.current) setSendBack(null);
        }}
        onSend={(reasonCode) => send('request-changes', { version, reasonCode })}
      />
    </section>
  );
}

function SendBackDialog({
  open,
  initialReason,
  pending,
  problem,
  onClose,
  onSend,
}: {
  readonly open: boolean;
  readonly initialReason: string;
  readonly pending: boolean;
  readonly problem: DecisionProblem | null;
  readonly onClose: () => void;
  readonly onSend: (reasonCode: string) => Promise<boolean>;
}) {
  const t = useTranslations('catalog.version.decision');
  const te = useTranslations('catalog.version.error');
  const [reason, setReason] = useState<string | null>(null);
  const [missing, setMissing] = useState(false);
  const value = reason ?? initialReason;
  const formId = 'send-back-form';

  function close() {
    setReason(null);
    setMissing(false);
    onClose();
  }

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (value === '') {
      setMissing(true);
      return;
    }
    if (await onSend(value)) {
      setReason(null);
      setMissing(false);
    }
  }

  return (
    <Dialog
      open={open}
      title={t('send-back-title')}
      onClose={close}
      actions={
        <>
          <Button variant="secondary" onClick={close} disabled={pending}>
            {t('cancel')}
          </Button>
          <Button type="submit" form={formId} loading={pending}>
            {t('send-back-confirm')}
          </Button>
        </>
      }
    >
      <form
        id={formId}
        onSubmit={(event) => void submit(event)}
        className="flex flex-col gap-4"
        noValidate
      >
        <p>{t('send-back-body')}</p>
        {problem === null ? null : <Banner tone="critical">{te(problem)}</Banner>}
        <Select
          label={t('reason')}
          placeholder={t('reason-placeholder')}
          value={value}
          required
          error={missing ? t('reason-missing') : undefined}
          onChange={(event) => {
            setReason(event.target.value);
            setMissing(false);
          }}
          options={PRODUCT_CHANGE_REASONS.map((code) => ({
            value: code,
            label: t(`reason-code.${code}`),
          }))}
        />
      </form>
    </Dialog>
  );
}
