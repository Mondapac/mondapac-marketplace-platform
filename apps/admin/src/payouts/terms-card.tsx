'use client';

import {
  ActionRow,
  Badge,
  Banner,
  Button,
  Card,
  CheckboxRow,
  DataList,
  Dialog,
  Select,
  TextField,
} from '@mondapac/ui';
import { useLocale, useTranslations } from 'next-intl';
import { useRef, useState } from 'react';
import { callApi } from '../api/client.ts';
import { isStepUpCancelled, useGuardedCall } from '../step-up/step-up.tsx';
import { formatMinor, parseAmount } from '../wallet/money.ts';
import { minorToField } from '../disputes/amount.ts';
import { MoneyField } from '../wallet/money-field.tsx';
import { sellerProblemOf } from './seller-errors.ts';
import {
  APPROVAL_MODES,
  HOLD_DAYS_MAX,
  HOLD_DAYS_MIN,
  TERMS_REASONS,
  WEEKDAYS,
  type PayoutTerms,
} from './seller-types.ts';

type Dialogs = 'edit' | 'remove' | null;
const TIME = /^([01][0-9]|2[0-3]):[0-5][0-9]$/;

/** The schedule as a sentence: "Tuesday 10:00, seller's time" or "Tue, Fri 10:00". */
function scheduleText(
  weekdays: readonly string[],
  localTime: string,
  day: (code: string) => string,
  short: (code: string) => string,
  suffix: string,
): string {
  const list = weekdays.length === 1 ? day(weekdays[0] ?? '') : weekdays.map(short).join(', ');
  return `${list} ${localTime}${suffix}`;
}

/**
 * A seller's payout terms: the terms in force, which of them are the seller's own, and the edit
 * and back-to-default actions. Both writes go through the guarded call (the shared step-up
 * dialog asks for the code) and need a reason from a closed list. The server decides every rule;
 * the form only keeps a request from leaving with a value it can see is out of range.
 */
export function PayoutTermsCard({
  initial,
  currency,
  canEdit,
  csrfToken,
}: {
  readonly initial: PayoutTerms;
  /** The Market currency of the minimum (the terms answer carries minor units only). */
  readonly currency: string | null;
  readonly canEdit: boolean;
  readonly csrfToken: string;
}) {
  const t = useTranslations('payouts.seller.terms');
  const locale = useLocale();
  const guarded = useGuardedCall();
  const [terms, setTerms] = useState(initial);
  const [dialog, setDialog] = useState<Dialogs>(null);
  const [notice, setNotice] = useState<'saved' | 'removed' | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const busy = useRef(false);

  // The edit form: each field is the seller's own only when its box is ticked.
  const [own, setOwn] = useState<Record<string, boolean>>({});
  const [days, setDays] = useState<readonly string[]>([]);
  const [time, setTime] = useState('');
  const [carrier, setCarrier] = useState('');
  const [click, setClick] = useState('');
  const [minimum, setMinimum] = useState('');
  const [mode, setMode] = useState('AUTO');
  const [reason, setReason] = useState('');
  const [errors, setErrors] = useState<Readonly<Record<string, string>>>({});

  const eff = terms.effective;
  const overridden = (field: keyof NonNullable<PayoutTerms['override']>) =>
    terms.override !== null && terms.override[field] !== null;
  const money = (minor: string) =>
    currency === null ? t('minor-units', { amount: minor }) : formatMinor(minor, currency, locale);
  const dayName = (code: string) => t(`day.${code}` as 'day.MON');
  const dayShort = (code: string) => t(`day-short.${code}` as 'day-short.MON');
  const own_badge = (field: keyof NonNullable<PayoutTerms['override']>) =>
    overridden(field) ? <Badge tone="attention">{t('own')}</Badge> : null;

  const row = (
    label: string,
    value: string,
    field: keyof NonNullable<PayoutTerms['override']>,
  ) => ({
    label,
    value: (
      <span className="flex flex-wrap items-center gap-2">
        <span>{value}</span>
        {own_badge(field)}
      </span>
    ),
  });

  function startEdit() {
    const o = terms.override;
    setOwn({
      schedule: o?.weekdays != null || o?.localTime != null,
      carrier: o?.holdDaysCarrier != null,
      click: o?.holdDaysSellerClick != null,
      minimum: o?.minimumMinor != null,
      mode: o?.approvalMode != null,
    });
    setDays(eff.weekdays);
    setTime(eff.localTime);
    setCarrier(String(eff.holdDaysCarrier));
    setClick(String(eff.holdDaysSellerClick));
    setMinimum(currency === null ? '' : minorToField(eff.minimumMinor, currency));
    setMode(eff.approvalMode);
    setReason('');
    setErrors({});
    setProblem(null);
    setNotice(null);
    setDialog('edit');
  }

  function adopt(next: PayoutTerms) {
    setTerms(next);
  }

  async function reread() {
    const result = await callApi<PayoutTerms>(
      'GET',
      `commission-payouts/admin/sellers/${terms.sellerId}/payout-terms`,
    );
    if (result.ok) adopt(result.body);
  }

  function fail(failure: Parameters<typeof sellerProblemOf>[0]) {
    if (failure.status === 401) {
      window.location.assign('/session-ended');
      return;
    }
    const key = sellerProblemOf(failure);
    setProblem(key);
    if (key === 'version-conflict' || key === 'terms-not-set') void reread();
  }

  async function save() {
    if (busy.current) return;
    const found: Record<string, string> = {};
    const body: Record<string, unknown> = {};
    if (own.schedule) {
      if (days.length === 0) found.schedule = t('error.days');
      if (!TIME.test(time)) found.time = t('error.time');
      body.weekdays = WEEKDAYS.filter((day) => days.includes(day));
      body.localTime = time;
    }
    const daysOf = (text: string) => (/^[0-9]{1,3}$/.test(text) ? Number(text) : -1);
    for (const [flag, text, key, field] of [
      ['carrier', carrier, 'holdDaysCarrier', 'carrier'],
      ['click', click, 'holdDaysSellerClick', 'click'],
    ] as const) {
      if (!own[flag]) continue;
      const n = daysOf(text);
      if (n < HOLD_DAYS_MIN || n > HOLD_DAYS_MAX) {
        found[field] = t('error.hold-days', { min: HOLD_DAYS_MIN, max: HOLD_DAYS_MAX });
      }
      body[key] = n;
    }
    if (own.minimum && currency !== null) {
      const typed = parseAmount(minimum, currency);
      if (!typed.ok) found.minimum = t('error.minimum');
      else body.minimumMinor = Number(typed.minor);
    }
    if (own.mode) body.approvalMode = mode;
    if (Object.keys(body).length === 0) found.none = t('error.none');
    if (reason === '') found.reason = t('error.reason');
    if (Object.keys(found).length > 0) {
      setErrors(found);
      return;
    }
    setErrors({});
    busy.current = true;
    setPending(true);
    setProblem(null);
    setDialog(null);
    const result = await guarded<PayoutTerms>(
      'PUT',
      `commission-payouts/admin/sellers/${terms.sellerId}/payout-terms`,
      { ...body, reasonCode: reason, expectedVersion: terms.version },
      csrfToken,
    );
    busy.current = false;
    setPending(false);
    if (result.ok) {
      adopt(result.body);
      setNotice('saved');
      return;
    }
    if (isStepUpCancelled(result)) {
      setDialog('edit');
      return;
    }
    fail(result.failure);
  }

  async function remove() {
    if (busy.current) return;
    if (reason === '') {
      setErrors({ reason: t('error.reason') });
      return;
    }
    busy.current = true;
    setPending(true);
    setProblem(null);
    setDialog(null);
    const result = await guarded<PayoutTerms>(
      'DELETE',
      `commission-payouts/admin/sellers/${terms.sellerId}/payout-terms?expectedVersion=${terms.version ?? -1}&reasonCode=${encodeURIComponent(reason)}`,
      undefined,
      csrfToken,
    );
    busy.current = false;
    setPending(false);
    if (result.ok) {
      adopt(result.body);
      setNotice('removed');
      return;
    }
    if (isStepUpCancelled(result)) {
      setDialog('remove');
      return;
    }
    fail(result.failure);
  }

  const reasonSelect = (
    <Select
      label={t('reason.label')}
      name="reasonCode"
      value={reason}
      error={errors.reason}
      options={[
        { value: '', label: t('reason.placeholder'), disabled: true },
        ...TERMS_REASONS.map((code) => ({ value: code, label: t(`reason.${code}`) })),
      ]}
      onChange={(event) => setReason(event.target.value)}
    />
  );

  return (
    <Card title={t('title')}>
      <div className="flex flex-col gap-4">
        {notice === null ? null : <Banner tone="success">{t(`done.${notice}`)}</Banner>}
        {problem === null ? null : <Banner tone="critical">{t(`error.${problem}`)}</Banner>}
        <DataList
          missing="-"
          rows={[
            row(
              t('schedule'),
              scheduleText(eff.weekdays, eff.localTime, dayName, dayShort, t('seller-time')),
              'weekdays',
            ),
            row(t('hold-carrier'), t('days', { count: eff.holdDaysCarrier }), 'holdDaysCarrier'),
            row(
              t('hold-click'),
              t('days', { count: eff.holdDaysSellerClick }),
              'holdDaysSellerClick',
            ),
            row(t('minimum'), money(eff.minimumMinor), 'minimumMinor'),
            row(
              t('approval'),
              t(`mode.${eff.approvalMode === 'MANUAL' ? 'MANUAL' : 'AUTO'}`),
              'approvalMode',
            ),
            {
              label: t('first-payout'),
              value: eff.firstPayoutManual ? t('first-manual') : t('first-auto'),
            },
          ]}
        />
        <p className="text-sm text-fg-muted">
          {t(terms.source === 'seller' ? 'note-seller' : 'note-market')}
        </p>
        {canEdit ? (
          <ActionRow>
            <Button variant="secondary" disabled={pending} onClick={startEdit}>
              {t('edit')}
            </Button>
            {terms.source === 'seller' ? (
              <Button
                variant="secondary"
                disabled={pending}
                onClick={() => {
                  setReason('');
                  setErrors({});
                  setProblem(null);
                  setNotice(null);
                  setDialog('remove');
                }}
              >
                {t('remove')}
              </Button>
            ) : null}
          </ActionRow>
        ) : null}
      </div>
      <Dialog
        open={dialog === 'edit'}
        title={t('edit-title')}
        onClose={() => setDialog(null)}
        actions={
          <>
            <Button variant="secondary" onClick={() => setDialog(null)}>
              {t('cancel')}
            </Button>
            <Button onClick={() => void save()}>{t('save')}</Button>
          </>
        }
      >
        <div className="flex flex-col gap-4">
          <p className="text-sm">{t('edit-intro')}</p>
          {errors.none === undefined ? null : <Banner tone="critical">{errors.none}</Banner>}
          <fieldset className="flex flex-col gap-3">
            <legend className="sr-only">{t('schedule')}</legend>
            <CheckboxRow
              label={t('own-field', { field: t('schedule') })}
              checked={own.schedule === true}
              onChange={(event) => setOwn({ ...own, schedule: event.target.checked })}
            />
            <div
              className="flex flex-wrap gap-x-4 gap-y-2"
              role="group"
              aria-label={t('days-group')}
            >
              {WEEKDAYS.map((code) => (
                <CheckboxRow
                  key={code}
                  label={dayShort(code)}
                  disabled={own.schedule !== true}
                  checked={days.includes(code)}
                  onChange={(event) =>
                    setDays(
                      event.target.checked
                        ? [...days, code]
                        : days.filter((entry) => entry !== code),
                    )
                  }
                />
              ))}
            </div>
            {errors.schedule === undefined ? null : (
              <p role="alert" className="text-sm text-critical-fg">
                {errors.schedule}
              </p>
            )}
            <TextField
              name="localTime"
              label={t('time')}
              help={t('time-help')}
              value={time}
              disabled={own.schedule !== true}
              error={errors.time}
              onChange={(event) => setTime(event.target.value)}
            />
          </fieldset>
          {(
            [
              ['carrier', 'hold-carrier', carrier, setCarrier],
              ['click', 'hold-click', click, setClick],
            ] as const
          ).map(([flag, label, value, set]) => (
            <div key={flag} className="flex flex-col gap-2">
              <CheckboxRow
                label={t('own-field', { field: t(label) })}
                checked={own[flag] === true}
                onChange={(event) => setOwn({ ...own, [flag]: event.target.checked })}
              />
              <TextField
                name={flag}
                label={t(label)}
                help={t('hold-help', { min: HOLD_DAYS_MIN, max: HOLD_DAYS_MAX })}
                inputMode="numeric"
                value={value}
                disabled={own[flag] !== true}
                error={errors[flag]}
                onChange={(event) => set(event.target.value)}
              />
            </div>
          ))}
          <div className="flex flex-col gap-2">
            <CheckboxRow
              label={t('own-field', { field: t('minimum') })}
              checked={own.minimum === true}
              disabled={currency === null}
              onChange={(event) => setOwn({ ...own, minimum: event.target.checked })}
            />
            <MoneyField
              name="minimum"
              label={currency === null ? t('minimum') : t('minimum-in', { currency })}
              help={currency === null ? t('minimum-no-currency') : t('minimum-help')}
              value={minimum}
              disabled={own.minimum !== true || currency === null}
              error={errors.minimum}
              onChange={(event) => setMinimum(event.target.value)}
            />
          </div>
          <div className="flex flex-col gap-2">
            <CheckboxRow
              label={t('own-field', { field: t('approval') })}
              checked={own.mode === true}
              onChange={(event) => setOwn({ ...own, mode: event.target.checked })}
            />
            <Select
              label={t('approval')}
              name="approvalMode"
              value={mode}
              disabled={own.mode !== true}
              options={APPROVAL_MODES.map((code) => ({ value: code, label: t(`mode.${code}`) }))}
              onChange={(event) => setMode(event.target.value)}
            />
          </div>
          {reasonSelect}
        </div>
      </Dialog>
      {/* No autoFocus: the Reason select is the first control, so the browser focuses it. */}
      <Dialog
        open={dialog === 'remove'}
        title={t('remove-title')}
        onClose={() => setDialog(null)}
        actions={
          <>
            <Button variant="secondary" onClick={() => setDialog(null)}>
              {t('cancel')}
            </Button>
            <Button onClick={() => void remove()}>{t('remove-yes')}</Button>
          </>
        }
      >
        <div className="flex flex-col gap-4">
          <p>{t('remove-body')}</p>
          {reasonSelect}
        </div>
      </Dialog>
    </Card>
  );
}
