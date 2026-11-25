'use client';

import {
  Badge,
  Banner,
  Button,
  ChartEmpty,
  ChartError,
  Dialog,
  Gauge,
  TextField,
  toast,
} from '@mondapac/ui';
import { useLocale, useTranslations } from 'next-intl';
import { useRouter } from 'next/navigation';
import { useEffect, useId, useRef, useState, type ReactNode } from 'react';
import { callApi, type ApiFailure } from '../../api/client.ts';
import { formatMinor, inputOf, minorOf } from '../../price/money.ts';
import { SELLER_GOAL_PATH, type SellerGoal, type SellerGoalFigures } from './types.ts';

// The body of the seller's "Monthly goal" card (dashboards v2, phase 2) and its editor. The card
// shows the current calendar month of the Market against the seller's own goal; the forecast is
// always labelled an estimate. The editor sets this month's goal through the panel server
// (PUT reporting/seller/monthly-goal) with the version shown, so a stale edit is refused; after a
// save the page reads its figures again. The API judges every refusal: no key, a store not
// approved, or an acting-as (Login as Seller) session, which answers 403 like a missing key.

const FIGURE = 'text-xl font-semibold tabular-nums text-fg';
const MUTED = 'text-xs text-fg-muted';

const BY_CODE: Readonly<Record<string, string>> = {
  'validation.failed': 'invalid',
  'reporting.seller-goal-conflict': 'conflict',
  'access.seller-not-approved': 'not-approved',
  'access.denied': 'denied',
  'request.csrf': 'csrf',
  'request.throttled': 'throttled',
};

/** The message key (under `dashboard.kpi.goal.error`) for a refused goal write. */
export function goalProblemOf(failure: ApiFailure): string {
  const named = BY_CODE[failure.code];
  if (named !== undefined) return named;
  if (failure.status === 403) return 'denied';
  if (failure.status === 409) return 'conflict';
  return failure.status === 503 || failure.status === 0 ? 'unavailable' : 'unknown';
}

const percent = (bp: number, locale: string): string =>
  new Intl.NumberFormat(locale, { style: 'percent', maximumFractionDigits: 1 }).format(bp / 10000);

const monthName = (month: string, locale: string): string => {
  const date = new Date(`${month}-01T00:00:00Z`);
  return Number.isNaN(date.getTime())
    ? month
    : new Intl.DateTimeFormat(locale, { month: 'long', timeZone: 'UTC' }).format(date);
};

const monthDay = (month: string, day: number, locale: string): string => {
  const date = new Date(`${month}-${String(day).padStart(2, '0')}T00:00:00Z`);
  return Number.isNaN(date.getTime())
    ? month
    : new Intl.DateTimeFormat(locale, { day: 'numeric', month: 'short', timeZone: 'UTC' }).format(
        date,
      );
};

function Tile({
  label,
  hint,
  children,
}: {
  readonly label: string;
  readonly hint?: string | undefined;
  readonly children: ReactNode;
}) {
  return (
    <div className="flex min-w-0 flex-col items-start gap-0.5 rounded-md border border-line bg-muted p-3">
      <span className={MUTED}>{label}</span>
      {children}
      {hint === undefined ? null : <span className={MUTED}>{hint}</span>}
    </div>
  );
}

/** The "Set goal" or "Edit goal" dialog for this month. */
function GoalDialog({
  goal,
  open,
  csrfToken,
  onClose,
}: {
  readonly goal: SellerGoalFigures;
  readonly open: boolean;
  readonly csrfToken: string;
  readonly onClose: () => void;
}) {
  const t = useTranslations('dashboard.kpi.goal');
  const locale = useLocale();
  const router = useRouter();
  const formId = useId();
  const [text, setText] = useState(goal.target === null ? '' : inputOf(goal.target, goal.currency));
  const [fieldError, setFieldError] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const busy = useRef(false);
  const alertRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (problem !== null) alertRef.current?.focus();
  }, [problem]);

  async function save() {
    if (busy.current) return;
    const amount = minorOf(text, goal.currency);
    if (amount === null) {
      setFieldError(true);
      return;
    }
    setFieldError(false);
    busy.current = true;
    setPending(true);
    setProblem(null);
    const result = await callApi<SellerGoal>(
      'PUT',
      SELLER_GOAL_PATH,
      { month: goal.month, amount, currency: goal.currency, expectedVersion: goal.version },
      csrfToken,
    );
    busy.current = false;
    setPending(false);
    if (result.ok) {
      toast.success(t('saved', { month: monthName(goal.month, locale) }));
      onClose();
      router.refresh();
      return;
    }
    if (result.failure.status === 401) {
      window.location.assign('/session-ended');
      return;
    }
    const code = goalProblemOf(result.failure);
    if (code === 'invalid') setFieldError(true);
    else setProblem(code);
  }

  return (
    <Dialog
      open={open}
      title={goal.target === null ? t('set-title') : t('edit-title')}
      onClose={onClose}
      actions={
        <>
          <Button variant="secondary" onClick={onClose} disabled={pending}>
            {t('cancel')}
          </Button>
          <Button type="submit" form={formId} loading={pending}>
            {t('save')}
          </Button>
        </>
      }
    >
      <form
        id={formId}
        noValidate
        className="flex flex-col gap-3"
        onSubmit={(event) => {
          event.preventDefault();
          void save();
        }}
      >
        {problem === null ? null : (
          <div ref={alertRef} tabIndex={-1} className="outline-none">
            <Banner tone="critical">
              {t(`error.${problem}` as 'error.unknown')}
              {problem === 'conflict' ? (
                <>
                  {' '}
                  <Button
                    variant="secondary"
                    onClick={() => {
                      onClose();
                      router.refresh();
                    }}
                  >
                    {t('reload')}
                  </Button>
                </>
              ) : null}
            </Banner>
          </div>
        )}
        <TextField
          name="goal"
          label={t('field', { month: monthName(goal.month, locale), currency: goal.currency })}
          help={t('field-help', { month: monthName(goal.month, locale), currency: goal.currency })}
          inputMode="decimal"
          autoComplete="off"
          dir="ltr"
          value={text}
          disabled={pending}
          error={fieldError ? t('error.amount') : undefined}
          onChange={(event) => setText(event.target.value)}
        />
      </form>
    </Dialog>
  );
}

/** "Set goal" or "Edit goal" in the card header (key `reporting.seller-goal.manage`). */
export function SellerGoalEditButton({
  goal,
  csrfToken,
}: {
  readonly goal: SellerGoalFigures;
  readonly csrfToken: string;
}) {
  const t = useTranslations('dashboard.kpi.goal');
  const [editing, setEditing] = useState(false);
  return (
    <>
      <Button
        variant="secondary"
        size="sm"
        className="min-h-11 min-w-11 lg:min-h-0 lg:min-w-0"
        onClick={() => setEditing(true)}
      >
        {goal.target === null ? t('set') : t('edit')}
      </Button>
      {editing ? (
        <GoalDialog goal={goal} open csrfToken={csrfToken} onClose={() => setEditing(false)} />
      ) : null}
    </>
  );
}

/** The in-place error of the card, with a secondary "Try again" that reads the page again. */
export function SellerGoalError() {
  const t = useTranslations('dashboard');
  const router = useRouter();
  return (
    <ChartError
      height={120}
      message={t('error.card')}
      retryLabel={t('kpi.goal.retry')}
      onRetry={() => router.refresh()}
    />
  );
}

/**
 * The month to date against the seller's goal. `canManage` only changes the hint of the empty
 * state; the Set or Edit button sits in the card header ({@link SellerGoalEditButton}).
 */
export function SellerGoalBody({
  goal,
  canManage,
}: {
  readonly goal: SellerGoalFigures;
  readonly canManage: boolean;
}) {
  const t = useTranslations('dashboard.kpi.goal');
  const locale = useLocale();
  const money = (amount: string) => formatMinor(amount, goal.currency, locale);
  const lastMonth = monthName(goal.lastMonth, locale);
  const forecast =
    goal.forecast.status === 'estimate'
      ? t('forecast', {
          amount: money(goal.forecast.amount),
          day: monthDay(goal.month, goal.daysInMonth, locale),
          month: lastMonth,
          last: money(goal.lastMonthTotal),
        })
      : t('forecast-not-enough', {
          day: goal.forecast.minimumDays + 1,
          month: lastMonth,
          last: money(goal.lastMonthTotal),
        });
  return (
    <div className="flex flex-col gap-3">
      {goal.target === null || goal.progressBp === null ? (
        <ChartEmpty
          height={96}
          message={t('none')}
          hint={canManage ? t('none-hint') : t('none-hint-read')}
        />
      ) : (
        <Gauge
          label={t('title')}
          value={goal.progressBp / 100}
          max={100}
          display={percent(goal.progressBp, locale)}
          caption={t('of-goal')}
          // The text alternative says the same figure as the centre (n is a percentage).
          formatValue={(n) => percent(Math.round(n * 100), locale)}
          emptyLabel={t('none')}
        />
      )}
      {goal.paceBp === null && goal.forecast.status !== 'estimate' ? null : (
        <div className="flex flex-wrap items-center gap-2">
          {goal.paceBp === null ? null : (
            <Badge tone={goal.paceBp >= 10000 ? 'success' : 'info'}>
              {t(goal.paceBp >= 10000 ? 'pace' : 'behind', {
                rate: percent(goal.paceBp, locale),
              })}
            </Badge>
          )}
          {goal.forecast.status === 'estimate' ? (
            <Badge tone="neutral">{t('estimate')}</Badge>
          ) : null}
        </div>
      )}
      <p className="m-0 text-sm text-fg-secondary">{forecast}</p>
      <div className="grid grid-cols-2 gap-3">
        <Tile label={t('goal')}>
          {goal.target === null ? (
            <span className="text-sm font-medium text-fg-secondary">{t('not-set')}</span>
          ) : (
            <span className={FIGURE}>{money(goal.target)}</span>
          )}
        </Tile>
        <Tile
          label={t('to-date', { month: monthName(goal.month, locale) })}
          hint={
            goal.toGo === null || goal.perDayToGo === null
              ? undefined
              : t('to-go', {
                  days: goal.daysLeft,
                  amount: money(goal.toGo),
                  perDay: money(goal.perDayToGo),
                })
          }
        >
          <span className={FIGURE}>{money(goal.monthToDate)}</span>
        </Tile>
      </div>
    </div>
  );
}
