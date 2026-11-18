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
  type BadgeTone,
} from '@mondapac/ui';
import { useLocale, useTranslations } from 'next-intl';
import { useCallback, useEffect, useState, type FormEvent } from 'react';
import { callApi, type ApiFailure } from '../api/client.ts';
import { formatInstant } from '../catalog/format.ts';
import { formatMinor, inputOf, minorOf } from '../price/money.ts';
import { instantOfZoned, resolveZone } from '../price/zone-time.ts';

export const PROMOTION_VIEW_PERMISSION = 'promotions.promotion.view';
export const PROMOTION_MANAGE_PERMISSION = 'promotions.promotion.manage';

const LIST_PATH = 'promotions/seller/promotions?type=CUSTOMER_GROUP&limit=100';
const BASE_PATH = 'promotions/seller/promotions';

export interface OwnPromotion {
  readonly id: string;
  readonly type: string;
  readonly status: 'PENDING_APPROVAL' | 'ACTIVE' | 'PAUSED' | 'REJECTED';
  readonly name: string;
  readonly funding: string;
  readonly startsAt: string;
  readonly endsAt: string | null;
  readonly currency: string;
  readonly reward: {
    readonly kind: 'PERCENT' | 'FIXED';
    readonly bps: number | null;
    readonly amountMinor: string | null;
  };
  readonly segment: { readonly kind: string } | null;
  readonly pausedBy: 'ADMIN' | 'SELLER' | null;
}

/** The exclusive discount among the seller's customer-group promotions (the one with this segment). */
export function exclusiveOf(items: readonly OwnPromotion[]): OwnPromotion | null {
  return (
    items.find(
      (item) => item.type === 'CUSTOMER_GROUP' && item.segment?.kind === 'SELLER_EXCLUSIVE',
    ) ?? null
  );
}

const PROBLEM_BY_CODE: Readonly<Record<string, string>> = {
  'promotions.code-taken': 'taken',
  'promotions.too-many-active': 'too-many',
  'promotions.not-editable': 'not-editable',
  'promotions.invalid-state': 'invalid-state',
  'promotions.not-found': 'not-found',
  'access.denied': 'denied',
  'request.csrf': 'csrf',
};

/** The message key (under `customers.perks.error`) of a failed promotion call. */
export function problemOf(failure: ApiFailure): string {
  if (failure.status === 429) return 'throttled';
  const named = PROBLEM_BY_CODE[failure.code];
  if (named !== undefined) return named;
  if (failure.code === 'validation.failed') return 'invalid';
  return failure.status === 0 || failure.status >= 500 ? 'unavailable' : 'unknown';
}

const STATUS_TONE: Record<string, BadgeTone> = {
  ACTIVE: 'success',
  PAUSED: 'attention',
  PENDING_APPROVAL: 'info',
  REJECTED: 'critical',
  ENDED: 'neutral',
};

/** What the card calls a promotion: its status, or Ended once an active one passed its end. */
export function displayStatus(promotion: OwnPromotion, now: Date): string {
  if (
    promotion.status === 'ACTIVE' &&
    promotion.endsAt !== null &&
    new Date(promotion.endsAt).getTime() < now.getTime()
  ) {
    return 'ENDED';
  }
  return promotion.status;
}

/** The body of a create or an edit: the whole definition, with the segment fixed to the shop's customers. */
export function promotionBody(input: {
  readonly name: string;
  readonly reward: Record<string, unknown>;
  readonly startsAt: string | null;
  readonly endsAt: string | null;
}): Record<string, unknown> {
  return {
    type: 'CUSTOMER_GROUP',
    name: input.name,
    funding: 'SELLER',
    segment: { kind: 'SELLER_EXCLUSIVE' },
    reward: input.reward,
    ...(input.startsAt === null ? {} : { startsAt: input.startsAt }),
    ...(input.endsAt === null ? {} : { endsAt: input.endsAt }),
  };
}

function ExclusiveDialog({
  promotion,
  zone,
  csrfToken,
  onClose,
  onDone,
}: {
  readonly promotion: OwnPromotion | null;
  readonly zone: string;
  readonly csrfToken: string;
  readonly onClose: () => void;
  readonly onDone: () => void;
}) {
  const t = useTranslations('customers.perks');
  const editing = promotion !== null;
  const fixed = promotion?.reward.kind === 'FIXED';
  const [name, setName] = useState(promotion?.name ?? '');
  const [amount, setAmount] = useState(() =>
    promotion === null
      ? ''
      : fixed
        ? inputOf(promotion.reward.amountMinor ?? '0', promotion.currency)
        : String((promotion.reward.bps ?? 0) / 100),
  );
  const [endsOn, setEndsOn] = useState(() =>
    promotion?.endsAt == null
      ? ''
      : new Intl.DateTimeFormat('en-CA', {
          timeZone: zone,
          year: 'numeric',
          month: '2-digit',
          day: '2-digit',
        }).format(new Date(promotion.endsAt)),
  );
  const [errors, setErrors] = useState<{ name?: string; amount?: string; endsOn?: string }>({});
  const [pending, setPending] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);

  async function submit(event?: FormEvent) {
    event?.preventDefault();
    if (pending) return;
    const next: typeof errors = {};
    if (name.trim() === '') next.name = t('form.error.name');
    let reward: Record<string, unknown> | null = null;
    if (fixed && promotion !== null) {
      const minor = minorOf(amount, promotion.currency);
      if (minor === null) next.amount = t('form.error.amount');
      else reward = { kind: 'FIXED', amountMinor: minor };
    } else {
      const percent = Number(amount.trim().replace(',', '.'));
      if (!/^\d{1,3}([.,]\d{1,2})?$/.test(amount.trim()) || percent <= 0 || percent > 100) {
        next.amount = t('form.error.percent');
      } else reward = { kind: 'PERCENT', bps: Math.round(percent * 100) };
    }
    let endsAt: string | null = promotion?.endsAt ?? null;
    if (endsOn.trim() === '') endsAt = null;
    else if (
      endsOn !== '' &&
      (promotion?.endsAt == null || endsOn !== promotionEndDay(promotion.endsAt, zone))
    ) {
      endsAt = /^\d{4}-\d{2}-\d{2}$/.test(endsOn) ? instantOfZoned(`${endsOn}T23:59`, zone) : null;
      if (endsAt === null) next.endsOn = t('form.error.date');
    }
    setErrors(next);
    if (reward === null || Object.keys(next).length > 0) return;
    setPending(true);
    setProblem(null);
    const body = promotionBody({
      name: name.trim(),
      reward,
      startsAt: promotion?.startsAt ?? null,
      endsAt,
    });
    const result = editing
      ? await callApi<OwnPromotion>('PATCH', `${BASE_PATH}/${promotion.id}`, body, csrfToken)
      : await callApi<OwnPromotion>('POST', BASE_PATH, body, csrfToken);
    setPending(false);
    if (result.ok) {
      toast.success(t(editing ? 'form.saved' : 'form.created'));
      onDone();
      return;
    }
    if (result.failure.status === 401) {
      window.location.assign('/session-ended');
      return;
    }
    setProblem(problemOf(result.failure));
  }

  return (
    <Dialog
      open
      title={t(editing ? 'form.title-edit' : 'form.title-create')}
      onClose={() => {
        if (!pending) onClose();
      }}
      actions={
        <>
          <Button variant="secondary" onClick={onClose} disabled={pending}>
            {t('form.cancel')}
          </Button>
          <Button loading={pending} onClick={() => void submit()}>
            {t(editing ? 'form.save' : 'form.create')}
          </Button>
        </>
      }
    >
      <form onSubmit={(event) => void submit(event)} noValidate className="flex flex-col gap-4">
        <p className="text-sm">
          <span className="font-medium">{t('form.who')}</span> {t('form.who-value')}
        </p>
        <TextField
          label={t('form.name')}
          value={name}
          maxLength={120}
          error={errors.name}
          onChange={(event) => setName(event.target.value)}
        />
        <TextField
          label={
            fixed && promotion !== null
              ? t('form.amount', { currency: promotion.currency })
              : t('form.percent')
          }
          inputMode="decimal"
          value={amount}
          error={errors.amount}
          help={t('form.fail-closed')}
          onChange={(event) => setAmount(event.target.value)}
        />
        <TextField
          label={t('form.ends')}
          type="date"
          value={endsOn}
          error={errors.endsOn}
          help={t('form.ends-help', { zone })}
          onChange={(event) => setEndsOn(event.target.value)}
        />
        {problem === null ? null : <Banner tone="critical">{t(`error.${problem}`)}</Banner>}
      </form>
    </Dialog>
  );
}

function promotionEndDay(iso: string, zone: string): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: zone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(new Date(iso));
}

type Load =
  | { readonly kind: 'loading' }
  | { readonly kind: 'ok'; readonly promotion: OwnPromotion | null }
  | { readonly kind: 'hidden' }
  | { readonly kind: 'off' }
  | { readonly kind: 'failed'; readonly key: string };

/**
 * Settings, Exclusive perks: the discount for the customers who joined through the invite link,
 * a seller promotion of type CUSTOMER_GROUP with the SELLER_EXCLUSIVE segment (the seller pays; the
 * segment is fixed and cannot be changed here). Create exclusive discount…, Edit…, Pause… and
 * Resume… follow the manage key. The API's own limits (the seller cap, review after publishing) are
 * shown as given. The cashback card waits for its API and the commission card for a seller route;
 * neither is drawn.
 */
export function ExclusivePerks({
  canManage,
  csrfToken,
  timeZone,
}: {
  readonly canManage: boolean;
  readonly csrfToken: string;
  readonly timeZone: string | null;
}) {
  const t = useTranslations('customers.perks');
  const tl = useTranslations('load');
  const locale = useLocale();
  const zone = resolveZone(timeZone);
  const [state, setState] = useState<Load>({ kind: 'loading' });
  const [dialog, setDialog] = useState<'form' | 'pause' | 'resume' | null>(null);
  const [pending, setPending] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);

  const load = useCallback(async () => {
    const result = await callApi<{ readonly items: readonly OwnPromotion[] }>('GET', LIST_PATH);
    if (result.ok) {
      setState({ kind: 'ok', promotion: exclusiveOf(result.body.items) });
      return;
    }
    const { failure } = result;
    if (failure.status === 401) {
      window.location.assign('/session-ended');
      return;
    }
    if (failure.status === 403) setState({ kind: 'hidden' });
    else if (failure.status === 404 && failure.code === 'promotions.disabled')
      setState({ kind: 'off' });
    else setState({ kind: 'failed', key: problemOf(failure) });
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const promotion = state.kind === 'ok' ? state.promotion : null;

  async function act(kind: 'pause' | 'resume') {
    if (promotion === null || pending) return;
    setPending(true);
    setProblem(null);
    const result = await callApi<OwnPromotion>(
      'POST',
      `${BASE_PATH}/${promotion.id}/${kind}`,
      {},
      csrfToken,
    );
    setPending(false);
    if (result.ok) {
      setDialog(null);
      toast.success(t(`${kind}.done`));
      void load();
      return;
    }
    if (result.failure.status === 401) {
      window.location.assign('/session-ended');
      return;
    }
    setProblem(problemOf(result.failure));
  }

  if (state.kind === 'hidden') return null;
  const now = new Date();
  const status = promotion === null ? null : displayStatus(promotion, now);
  const adminPaused = promotion?.status === 'PAUSED' && promotion.pausedBy === 'ADMIN';
  return (
    <div className="flex flex-col gap-4">
      <p className="text-fg-muted">{t('intro')}</p>
      <Card title={t('discount.title')}>
        {state.kind === 'loading' ? (
          <div className="flex items-center gap-2 text-fg-muted" role="status">
            <Spinner />
            {t('loading')}
          </div>
        ) : state.kind === 'off' ? (
          <p>{t('off')}</p>
        ) : state.kind === 'failed' ? (
          <LoadError
            className="w-full"
            message={t(`error.${state.key}`)}
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
            title={t('discount.none-title')}
            body={t('discount.none-body')}
            action={
              canManage ? (
                <Button onClick={() => setDialog('form')}>{t('discount.create')}</Button>
              ) : undefined
            }
          />
        ) : (
          <>
            <div className="flex flex-wrap items-center gap-2">
              <h3 className="text-base font-semibold">{promotion.name}</h3>
              <Badge tone={STATUS_TONE[status ?? ''] ?? 'neutral'}>
                {t(`status.${status ?? ''}`)}
              </Badge>
            </div>
            <dl className="grid gap-2 text-sm sm:grid-cols-3">
              <div>
                <dt className="text-fg-muted">{t('discount.reward')}</dt>
                <dd className="font-medium" dir="ltr">
                  {promotion.reward.kind === 'PERCENT'
                    ? `${(promotion.reward.bps ?? 0) / 100}%`
                    : formatMinor(promotion.reward.amountMinor ?? '0', promotion.currency, locale)}
                </dd>
              </div>
              <div>
                <dt className="text-fg-muted">{t('discount.who')}</dt>
                <dd className="font-medium">{t('form.who-value')}</dd>
              </div>
              <div>
                <dt className="text-fg-muted">{t('discount.dates')}</dt>
                <dd className="font-medium">
                  {formatInstant(promotion.startsAt, locale, zone)}
                  {promotion.endsAt === null
                    ? ` - ${t('discount.no-end')}`
                    : ` - ${formatInstant(promotion.endsAt, locale, zone)}`}
                </dd>
              </div>
            </dl>
            <p className="text-sm text-fg-muted">{t('form.fail-closed')}</p>
            {promotion.status === 'PENDING_APPROVAL' ? (
              <Banner tone="info">{t('discount.pending')}</Banner>
            ) : null}
            {adminPaused ? <Banner tone="attention">{t('discount.admin-paused')}</Banner> : null}
            {canManage ? (
              <div className="flex flex-wrap gap-2">
                {status !== 'ENDED' ? (
                  <Button variant="secondary" onClick={() => setDialog('form')}>
                    {t('discount.edit')}
                  </Button>
                ) : null}
                {promotion.status === 'ACTIVE' && status !== 'ENDED' ? (
                  <Button
                    variant="secondary"
                    onClick={() => {
                      setProblem(null);
                      setDialog('pause');
                    }}
                  >
                    {t('discount.pause')}
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
                    {t('discount.resume')}
                  </Button>
                ) : null}
              </div>
            ) : null}
          </>
        )}
      </Card>
      {dialog === 'form' ? (
        <ExclusiveDialog
          promotion={promotion}
          zone={zone}
          csrfToken={csrfToken}
          onClose={() => setDialog(null)}
          onDone={() => {
            setDialog(null);
            void load();
          }}
        />
      ) : null}
      <ConfirmAction
        open={dialog === 'pause' || dialog === 'resume'}
        level={2}
        title={t(`${dialog === 'resume' ? 'resume' : 'pause'}.title`)}
        body={t(`${dialog === 'resume' ? 'resume' : 'pause'}.body`)}
        rowName=""
        confirmLabel={t(`${dialog === 'resume' ? 'resume' : 'pause'}.confirm`)}
        cancelLabel={t('form.cancel')}
        pending={pending}
        error={problem === null ? null : t(`error.${problem}`)}
        onConfirm={() => void act(dialog === 'resume' ? 'resume' : 'pause')}
        onCancel={() => setDialog(null)}
      />
    </div>
  );
}
