'use client';

import {
  Badge,
  Banner,
  Button,
  Card,
  ConfirmAction,
  Dialog,
  EmptyState,
  LoadError,
  Spinner,
  TextField,
  toast,
} from '@mondapac/ui';
import { useLocale, useTranslations } from 'next-intl';
import { useCallback, useEffect, useState, type FormEvent } from 'react';
import { callApi, type ApiFailure } from '../api/client.ts';
import { formatInstant } from '../catalog/format.ts';
import { formatMinor, inputOf, minorOf } from '../price/money.ts';
import {
  PROMOTIONS_BASE_PATH,
  STATUS_TONE,
  displayStatus,
  problemOf,
  type OwnPromotion,
} from './perks-shared.ts';

const LIST_PATH = `${PROMOTIONS_BASE_PATH}?type=CASHBACK&limit=100`;
/** The name of a cashback the seller makes: the card has no name field (one cashback per shop). */
const DEFAULT_NAME = 'Exclusive cashback';

/** A cashback that can still apply or be edited: not rejected, not past its end. */
export function isLive(promotion: OwnPromotion, now: Date): boolean {
  return promotion.status !== 'REJECTED' && displayStatus(promotion, now) !== 'ENDED';
}

/**
 * The seller's exclusive cashback among its cashback promotions: a live one (active, paused or in
 * review) first, else the first other one (rejected or ended), which the card shows for context.
 */
export function cashbackOf(
  items: readonly OwnPromotion[],
  now: Date = new Date(),
): OwnPromotion | null {
  const own = items.filter(
    (item) => item.type === 'CASHBACK' && item.segment?.kind === 'SELLER_EXCLUSIVE',
  );
  return own.find((item) => isLive(item, now)) ?? own[0] ?? null;
}

/** The whole definition of a create or an edit; the segment and the funding are fixed. */
export function cashbackBody(input: {
  readonly name: string;
  readonly bps: number;
  readonly capMinor: string;
  readonly startsAt: string | null;
  readonly endsAt: string | null;
}): Record<string, unknown> {
  return {
    type: 'CASHBACK',
    name: input.name,
    funding: 'SELLER',
    segment: { kind: 'SELLER_EXCLUSIVE' },
    reward: { kind: 'PERCENT', bps: input.bps },
    capMinor: input.capMinor,
    ...(input.startsAt === null ? {} : { startsAt: input.startsAt }),
    ...(input.endsAt === null ? {} : { endsAt: input.endsAt }),
  };
}

/** The API says cashback is not available in the Market (the customer wallet is off there). */
export function walletOffOf(failure: ApiFailure): boolean {
  if (failure.status === 404 && failure.code === 'promotions.disabled') return true;
  return (
    failure.code === 'validation.failed' &&
    (failure.details?.fields ?? []).some(
      (field) => field.path === 'type' && field.code === 'unavailable',
    )
  );
}

/** The inline field message keys of a refused cashback, from the API's own field codes. */
export function fieldProblems(failure: ApiFailure): { percent?: string; cap?: string } {
  const out: { percent?: string; cap?: string } = {};
  for (const field of failure.details?.fields ?? []) {
    if (field.path === 'reward.bps' || field.path === 'reward.kind' || field.path === 'reward') {
      out.percent =
        field.code === 'exceeds-market-limit'
          ? 'percent-high'
          : field.code === 'below-market-minimum'
            ? 'percent-low'
            : 'percent';
    } else if (field.path === 'capMinor') {
      out.cap = field.code === 'exceeds-market-limit' ? 'cap-high' : 'cap';
    }
  }
  return out;
}

function CashbackDialog({
  promotion,
  currency,
  csrfToken,
  onClose,
  onDone,
  onWalletOff,
}: {
  readonly promotion: OwnPromotion | null;
  /** The Market currency when a promotion of the seller shows it; null when it cannot be known. */
  readonly currency: string | null;
  readonly csrfToken: string;
  readonly onClose: () => void;
  readonly onDone: () => void;
  readonly onWalletOff: () => void;
}) {
  const t = useTranslations('customers.perks');
  const editing = promotion !== null;
  const [percent, setPercent] = useState(
    promotion === null ? '' : String((promotion.reward.bps ?? 0) / 100),
  );
  const [cap, setCap] = useState(() => {
    if (promotion?.capMinor == null) return '';
    return currency === null ? promotion.capMinor : inputOf(promotion.capMinor, currency);
  });
  const [errors, setErrors] = useState<{ percent?: string; cap?: string }>({});
  const [pending, setPending] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);

  async function submit(event?: FormEvent) {
    event?.preventDefault();
    if (pending) return;
    const next: typeof errors = {};
    const text = percent.trim();
    const value = Number(text.replace(',', '.'));
    if (!/^\d{1,3}([.,]\d{1,2})?$/.test(text) || value <= 0 || value > 100) {
      next.percent = t('cashback.form.error.percent');
    }
    let capMinor: string | null;
    if (currency === null) capMinor = /^[1-9]\d{0,14}$/.test(cap.trim()) ? cap.trim() : null;
    else capMinor = minorOf(cap, currency);
    if (capMinor === null || /^0+$/.test(capMinor)) {
      next.cap = t(currency === null ? 'cashback.form.error.cap-minor' : 'cashback.form.error.cap');
      capMinor = null;
    }
    setErrors(next);
    if (capMinor === null || Object.keys(next).length > 0) return;
    setPending(true);
    setProblem(null);
    const body = cashbackBody({
      name: promotion?.name ?? DEFAULT_NAME,
      bps: Math.round(value * 100),
      capMinor,
      startsAt: promotion?.startsAt ?? null,
      endsAt: promotion?.endsAt ?? null,
    });
    const result = editing
      ? await callApi<OwnPromotion>(
          'PATCH',
          `${PROMOTIONS_BASE_PATH}/${promotion.id}`,
          body,
          csrfToken,
        )
      : await callApi<OwnPromotion>('POST', PROMOTIONS_BASE_PATH, body, csrfToken);
    setPending(false);
    if (result.ok) {
      toast.success(t(editing ? 'cashback.form.saved' : 'cashback.form.created'));
      onDone();
      return;
    }
    const { failure } = result;
    if (failure.status === 401) {
      window.location.assign('/session-ended');
      return;
    }
    if (walletOffOf(failure)) {
      onWalletOff();
      return;
    }
    const fields = fieldProblems(failure);
    if (fields.percent !== undefined || fields.cap !== undefined) {
      setErrors({
        ...(fields.percent === undefined
          ? {}
          : { percent: t(`cashback.form.error.${fields.percent}`) }),
        ...(fields.cap === undefined ? {} : { cap: t(`cashback.form.error.${fields.cap}`) }),
      });
      return;
    }
    setProblem(failureKey(failure));
  }

  return (
    <Dialog
      open
      title={t(editing ? 'cashback.form.title-edit' : 'cashback.form.title-create')}
      onClose={() => {
        if (!pending) onClose();
      }}
      actions={
        <>
          <Button variant="secondary" onClick={onClose} disabled={pending}>
            {t('cashback.form.cancel')}
          </Button>
          <Button loading={pending} onClick={() => void submit()}>
            {t(editing ? 'cashback.form.save' : 'cashback.form.create')}
          </Button>
        </>
      }
    >
      <form onSubmit={(event) => void submit(event)} noValidate className="flex flex-col gap-4">
        <p className="text-sm">
          <span className="font-medium">{t('cashback.form.who')}</span>{' '}
          {t('cashback.form.who-value')}
        </p>
        <TextField
          label={t('cashback.form.percent')}
          inputMode="decimal"
          value={percent}
          error={errors.percent}
          help={t('cashback.form.percent-help')}
          onChange={(event) => setPercent(event.target.value)}
        />
        <TextField
          label={
            currency === null ? t('cashback.form.cap-minor') : t('cashback.form.cap', { currency })
          }
          inputMode="decimal"
          value={cap}
          error={errors.cap}
          help={t(currency === null ? 'cashback.form.cap-minor-help' : 'cashback.form.cap-help')}
          onChange={(event) => setCap(event.target.value)}
        />
        <p className="text-sm text-fg-muted">{t('cashback.terms')}</p>
        {problem === null ? null : <Banner tone="critical">{problemText(problem, t)}</Banner>}
      </form>
    </Dialog>
  );
}

/** The throttle answer carries the wait: "Try again in {n} minutes". */
function failureKey(failure: ApiFailure): string {
  if (failure.status === 429) {
    const seconds = failure.details?.retryAfterSeconds;
    return `throttled:${Math.max(1, Math.ceil((seconds ?? 60) / 60))}`;
  }
  return problemOf(failure);
}

function problemText(key: string, t: (key: string, values?: { n: number }) => string): string {
  if (key.startsWith('throttled:'))
    return t('cashback.error.throttled', { n: Number(key.slice(10)) });
  return t(`error.${key}`);
}

type Load =
  | { readonly kind: 'loading' }
  | { readonly kind: 'ok'; readonly promotion: OwnPromotion | null }
  | { readonly kind: 'hidden' }
  | { readonly kind: 'off' }
  | { readonly kind: 'wallet-off' }
  | { readonly kind: 'failed'; readonly key: string };

/**
 * Settings, Exclusive perks: the cashback for the customers who joined through the invite link, a
 * seller promotion of type CASHBACK with the SELLER_EXCLUSIVE segment (the seller pays it from the
 * payout; the segment is fixed). The percent and the per-order cap are checked by the API against
 * the Market's limits; its refusals are shown as given. The card hides alone on a 403 and says so
 * when the customer wallet (so cashback) is off in the Market.
 */
export function CashbackCard({
  canManage,
  csrfToken,
  timeZone,
  currencyHint,
  onHidden,
}: {
  readonly canManage: boolean;
  readonly csrfToken: string;
  readonly timeZone: string;
  /** A currency seen on another promotion of the seller; used only when it has no cashback yet. */
  readonly currencyHint: string | null;
  readonly onHidden: () => void;
}) {
  const t = useTranslations('customers.perks');
  const tl = useTranslations('load');
  const locale = useLocale();
  const [state, setState] = useState<Load>({ kind: 'loading' });
  const [dialog, setDialog] = useState<'form' | 'pause' | 'resume' | null>(null);
  const [pending, setPending] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);

  const load = useCallback(async () => {
    const result = await callApi<{ readonly items: readonly OwnPromotion[] }>('GET', LIST_PATH);
    if (result.ok) {
      setState({ kind: 'ok', promotion: cashbackOf(result.body.items) });
      return;
    }
    const { failure } = result;
    if (failure.status === 401) {
      window.location.assign('/session-ended');
      return;
    }
    if (failure.status === 403) {
      setState({ kind: 'hidden' });
      onHidden();
    } else if (failure.status === 404 && failure.code === 'promotions.disabled') {
      setState({ kind: 'off' });
    } else setState({ kind: 'failed', key: failureKey(failure) });
  }, [onHidden]);

  useEffect(() => {
    void load();
  }, [load]);

  const promotion = state.kind === 'ok' ? state.promotion : null;
  const currency = promotion?.currency ?? currencyHint;

  async function act(kind: 'pause' | 'resume') {
    if (promotion === null || pending) return;
    setPending(true);
    setProblem(null);
    const result = await callApi<OwnPromotion>(
      'POST',
      `${PROMOTIONS_BASE_PATH}/${promotion.id}/${kind}`,
      {},
      csrfToken,
    );
    setPending(false);
    if (result.ok) {
      setDialog(null);
      toast.success(t(`cashback.${kind}.done`));
      void load();
      return;
    }
    if (result.failure.status === 401) {
      window.location.assign('/session-ended');
      return;
    }
    if (walletOffOf(result.failure)) {
      setDialog(null);
      setState({ kind: 'wallet-off' });
      return;
    }
    setProblem(failureKey(result.failure));
  }

  if (state.kind === 'hidden') return null;
  const status = promotion === null ? null : displayStatus(promotion, new Date());
  const live = promotion !== null && isLive(promotion, new Date());
  const adminPaused = promotion?.status === 'PAUSED' && promotion.pausedBy === 'ADMIN';
  const tc = (key: string, values?: Record<string, string | number>) =>
    t(`cashback.${key}`, values);
  const failed = state.kind === 'failed' ? state.key : null;
  return (
    <>
      <Card title={tc('title')}>
        {state.kind === 'loading' ? (
          <div className="flex items-center gap-2 text-fg-muted" role="status">
            <Spinner />
            {t('loading')}
          </div>
        ) : state.kind === 'off' ? (
          <p>{t('off')}</p>
        ) : state.kind === 'wallet-off' ? (
          <p>{tc('wallet-off')}</p>
        ) : failed !== null ? (
          <LoadError
            className="w-full"
            message={problemText(failed, t)}
            retryLabel={tl('retry')}
            onRetry={() => {
              setState({ kind: 'loading' });
              void load();
            }}
          />
        ) : promotion === null ? (
          <EmptyState
            size="compact"
            icon="tag"
            title={tc('none-title')}
            body={tc('none-body')}
            action={
              canManage ? (
                <Button onClick={() => setDialog('form')}>{tc('button.create')}</Button>
              ) : undefined
            }
          />
        ) : (
          <>
            <div className="flex flex-wrap items-center gap-2">
              <h3 className="text-base font-semibold">{tc('current')}</h3>
              <Badge tone={STATUS_TONE[status ?? ''] ?? 'neutral'}>
                {t(`status.${status ?? ''}`)}
              </Badge>
            </div>
            <dl className="grid gap-2 text-sm sm:grid-cols-3">
              <div>
                <dt className="text-fg-muted">{tc('percent')}</dt>
                <dd className="font-medium" dir="ltr">
                  {`${(promotion.reward.bps ?? 0) / 100}%`}
                </dd>
              </div>
              <div>
                <dt className="text-fg-muted">{tc('cap')}</dt>
                <dd className="font-medium" dir="ltr">
                  {promotion.capMinor == null
                    ? '-'
                    : formatMinor(promotion.capMinor, promotion.currency, locale)}
                </dd>
              </div>
              <div>
                <dt className="text-fg-muted">{tc('since')}</dt>
                <dd className="font-medium">
                  {formatInstant(promotion.startsAt, locale, timeZone)}
                </dd>
              </div>
            </dl>
            <p className="text-sm text-fg-muted">{tc('terms')}</p>
            {promotion.status === 'PENDING_APPROVAL' ? (
              <Banner tone="info">{tc('pending')}</Banner>
            ) : null}
            {adminPaused ? <Banner tone="attention">{tc('admin-paused')}</Banner> : null}
            {canManage ? (
              <div className="flex flex-wrap gap-2">
                {live ? (
                  <Button variant="secondary" onClick={() => setDialog('form')}>
                    {tc('button.edit')}
                  </Button>
                ) : (
                  <Button onClick={() => setDialog('form')}>{tc('button.create')}</Button>
                )}
                {promotion.status === 'ACTIVE' && status !== 'ENDED' ? (
                  <Button
                    variant="secondary"
                    onClick={() => {
                      setProblem(null);
                      setDialog('pause');
                    }}
                  >
                    {tc('button.pause')}
                  </Button>
                ) : null}
                {promotion.status === 'PAUSED' && !adminPaused ? (
                  <Button
                    variant="secondary"
                    onClick={() => {
                      setProblem(null);
                      setDialog('resume');
                    }}
                  >
                    {tc('button.resume')}
                  </Button>
                ) : null}
              </div>
            ) : null}
          </>
        )}
      </Card>
      {dialog === 'form' ? (
        <CashbackDialog
          promotion={live ? promotion : null}
          currency={currency}
          csrfToken={csrfToken}
          onClose={() => setDialog(null)}
          onDone={() => {
            setDialog(null);
            void load();
          }}
          onWalletOff={() => {
            setDialog(null);
            setState({ kind: 'wallet-off' });
          }}
        />
      ) : null}
      <ConfirmAction
        open={dialog === 'pause' || dialog === 'resume'}
        level={2}
        title={tc(`${dialog === 'resume' ? 'resume' : 'pause'}.title`)}
        body={tc(`${dialog === 'resume' ? 'resume' : 'pause'}.body`)}
        rowName=""
        confirmLabel={tc(`${dialog === 'resume' ? 'resume' : 'pause'}.confirm`)}
        cancelLabel={tc('form.cancel')}
        pending={pending}
        error={problem === null ? null : problemText(problem, t)}
        onConfirm={() => void act(dialog === 'resume' ? 'resume' : 'pause')}
        onCancel={() => setDialog(null)}
      />
    </>
  );
}
