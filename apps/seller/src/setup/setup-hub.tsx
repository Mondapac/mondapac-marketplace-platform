import { Badge, Banner, Card } from '@mondapac/ui';
import { useFormatter, useTranslations } from 'next-intl';
import Link from 'next/link';
import { REVIEW_HREF, SETUP_STEPS, type SetupStepKey } from './steps.ts';
import { WithdrawSubmission } from './withdraw-submission.tsx';
import type { MissingPart, MyFile } from './types.ts';

// Which missing parts belong to which step. Until the API sends `onboardingSteps` the hub derives
// each step's state from `missing` (sellers ux 3.1 S1 and 3.3).
const PARTS: Readonly<Record<SetupStepKey, readonly MissingPart[]>> = {
  business: ['storeName', 'businessName', 'phone'],
  address: ['address', 'timezone'],
  number: ['identifier'],
  slug: ['slug'],
};

type StepState = 'done' | 'todo' | 'needs' | 'waiting';
type HubState =
  'details-incomplete' | 'ready' | 'outside-area' | 'awaiting-review' | 'changes-needed';

const STATE_TEXT: Record<StepState, string> = {
  done: 'account.step-done',
  todo: 'account.step-todo',
  needs: 'account.step-needs',
  waiting: 'account.status-waiting',
};
const STATE_TONE: Record<StepState, string> = {
  done: 'text-success-fg',
  todo: 'text-fg-muted',
  needs: 'text-attention-fg',
  waiting: 'text-fg-muted',
};
const BADGE_TONE = {
  'details-incomplete': 'neutral',
  ready: 'info',
  'outside-area': 'attention',
  'awaiting-review': 'info',
  'changes-needed': 'attention',
} as const;
const BANNER_TONE = {
  'details-incomplete': 'info',
  ready: 'info',
  'outside-area': 'attention',
  'awaiting-review': 'info',
  'changes-needed': 'attention',
} as const;

/** The state the hub shows for the API's one status; anything else reads as details still needed. */
function hubStateOf(file: MyFile, derived: HubState): HubState {
  switch (file.status) {
    case 'awaiting-review':
      return 'awaiting-review';
    case 'changes-needed':
      return 'changes-needed';
    case 'outside-service-area':
      return 'outside-area';
    case 'ready-to-submit':
      return 'ready';
    default:
      return derived;
  }
}

function Row({
  title,
  state,
  detail,
  href,
}: {
  readonly title: string;
  readonly state: StepState;
  readonly detail?: string | undefined;
  readonly href?: string | undefined;
}) {
  const t = useTranslations('sellers');
  const body = (
    <>
      <span className="flex flex-col">
        <span className="font-medium text-fg">{title}</span>
        <span className={`text-sm ${STATE_TONE[state]}`}>{t(STATE_TEXT[state])}</span>
        {detail ? <span className="text-sm text-fg-muted">{detail}</span> : null}
      </span>
      {href ? (
        <span aria-hidden className="text-fg-muted">
          ›
        </span>
      ) : null}
    </>
  );
  const row = 'flex items-center justify-between gap-4 py-3 first:pt-0 last:pb-0';
  return (
    <li>
      {href ? (
        <Link href={href} className={`${row} hover:underline`}>
          {body}
        </Link>
      ) : (
        <div className={row}>{body}</div>
      )}
    </li>
  );
}

/** S1: where the seller stands and the checklist of what to do next (sellers ux 3.1 S1, 3.3). */
export function SetupHub({
  file,
  csrfToken,
}: {
  readonly file: MyFile;
  readonly csrfToken: string;
}) {
  const t = useTranslations('sellers');
  const format = useFormatter();
  const zone = file.timezone?.operatingTimezone;
  const outside = file.outsideServiceArea === true;
  const left = (key: SetupStepKey) =>
    PARTS[key].filter((part) => file.missing.includes(part)).length;
  const allDone = SETUP_STEPS.every((step) => left(step.key) === 0);
  const derived: HubState = outside ? 'outside-area' : allDone ? 'ready' : 'details-incomplete';
  const state = hubStateOf(file, derived);
  const waiting = state === 'awaiting-review';
  const canSubmit =
    state === 'ready' || (state === 'changes-needed' && file.draftComplete && !outside);
  const when = (iso: string, style: 'date' | 'dateTime') =>
    format.dateTime(new Date(iso), {
      dateStyle: 'medium',
      ...(style === 'dateTime' ? { timeStyle: 'short' as const } : {}),
      ...(zone === undefined ? {} : { timeZone: zone }),
    });
  const withdrawal = file.latestWithdrawal;
  return (
    <div className="flex max-w-(--mp-size-form-max) flex-col gap-5">
      <div className="flex flex-wrap items-center gap-3">
        <h1 className="text-2xl font-semibold text-fg">{t('account.title')}</h1>
        <Badge tone={BADGE_TONE[state]}>{t(`account.badge.${state}`)}</Badge>
      </div>
      <Banner tone={BANNER_TONE[state]} title={t(`account.banner.${state}.title`)}>
        {t(`account.banner.${state}.body`)}
      </Banner>
      {waiting && file.submission !== null ? (
        <p className="text-sm text-fg-muted">
          {t('account.submitted-on', { dateTime: when(file.submission.submittedAt, 'dateTime') })}
        </p>
      ) : null}
      {!waiting && withdrawal !== null ? (
        <Banner tone="info">
          {t(withdrawal.byKind === 'seller' ? 'account.withdrawn-self' : 'account.withdrawn', {
            date: when(withdrawal.at, 'date'),
          })}
        </Banner>
      ) : null}
      <Card title={t('account.steps')}>
        <ol className="flex flex-col divide-y divide-line">
          <Row title={t('account.account-created')} state="done" />
          <Row title={t('account.email-confirmed')} state="done" />
          {SETUP_STEPS.map((step) => {
            const count = left(step.key);
            const needs = outside && step.key === 'address';
            const stepState: StepState = needs ? 'needs' : count === 0 ? 'done' : 'todo';
            const detail = needs
              ? t('account.detail-not-in-area')
              : count > 0
                ? t('account.detail-fields-left', { count })
                : undefined;
            return (
              <Row
                key={step.key}
                title={t(`steps.${step.key}`)}
                state={stepState}
                detail={detail}
                href={step.href}
              />
            );
          })}
          <Row
            title={t('steps.submit')}
            state={waiting ? 'done' : canSubmit ? 'todo' : 'waiting'}
            detail={
              waiting ? t('account.submit-done') : canSubmit ? undefined : t('account.submit-later')
            }
            href={canSubmit ? REVIEW_HREF : undefined}
          />
          <Row title={t('account.review')} state={waiting ? 'waiting' : 'todo'} />
        </ol>
      </Card>
      {waiting ? <WithdrawSubmission csrfToken={csrfToken} /> : null}
    </div>
  );
}
