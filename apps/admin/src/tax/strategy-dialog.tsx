'use client';

import { Banner, Select, SettingsDrawer, TextField, toast } from '@mondapac/ui';
import { useTranslations } from 'next-intl';
import { useRef, useState } from 'react';
import { callApi } from '../api/client.ts';
import { useDrawerLabels } from '../settings/drawer-labels.ts';
import { taxProblemOf } from './errors.ts';
import {
  parsePercent,
  percentInput,
  STRATEGY_NAME_MAX,
  TAX_STRATEGIES_PATH,
  type StrategyKind,
  type StrategyRequest,
  type TaxStrategy,
} from './types.ts';

/**
 * Add (`POST tax/admin/strategies`) or edit (`PUT tax/admin/strategies/:id`) one strategy. The
 * rates are typed as percentages and sent as basis points. The drawer is mounted per opening.
 */
export function StrategyDialog({
  strategy,
  categoryCodes,
  csrfToken,
  onClose,
  onSaved,
  onGone,
}: {
  /** The strategy to edit; null adds a new one. */
  readonly strategy: TaxStrategy | null;
  readonly categoryCodes: readonly string[];
  readonly csrfToken: string;
  readonly onClose: () => void;
  /** The list changed: the screen reads it again. */
  readonly onSaved: () => void;
  /** The strategy to edit no longer exists. */
  readonly onGone: () => void;
}) {
  const t = useTranslations('tax.dialog');
  const errors = useTranslations('tax.error');
  const kinds = useTranslations('tax.kind');
  const [name, setName] = useState(strategy?.name ?? '');
  const [kind, setKind] = useState<StrategyKind>(strategy?.kind ?? 'flat-rate');
  const [rate, setRate] = useState(strategy?.rateBps == null ? '' : percentInput(strategy.rateBps));
  const [defaultRate, setDefaultRate] = useState(
    strategy?.defaultRateBps == null ? '' : percentInput(strategy.defaultRateBps),
  );
  const [rates, setRates] = useState<Record<string, string>>(() =>
    Object.fromEntries(
      categoryCodes.map((code) => {
        const bps = strategy?.categoryRatesBps?.[code];
        return [code, bps === undefined ? '' : percentInput(bps)];
      }),
    ),
  );
  const [invalid, setInvalid] = useState<ReadonlySet<string>>(new Set());
  const [problem, setProblem] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const inFlight = useRef(false);
  const labels = useDrawerLabels(t('save'));
  const snapshot = () => JSON.stringify([name, kind, rate, defaultRate, rates]);
  // What the form held when it opened: closing with anything else asks first.
  const [start] = useState(snapshot);

  async function submit() {
    if (inFlight.current) return;
    setProblem(null);
    const bad = new Set<string>();
    const trimmed = name.trim();
    if (trimmed.length < 1 || trimmed.length > STRATEGY_NAME_MAX) bad.add('name');
    let body: StrategyRequest;
    if (kind === 'flat-rate') {
      const bps = parsePercent(rate);
      if (bps === null) bad.add('rate');
      body = { name: trimmed, kind, rateBps: bps ?? 0 };
    } else {
      const bps = parsePercent(defaultRate);
      if (bps === null) bad.add('default');
      const categoryRatesBps: Record<string, number> = {};
      for (const code of categoryCodes) {
        const value = parsePercent(rates[code] ?? '');
        if (value === null) bad.add(code);
        else categoryRatesBps[code] = value;
      }
      body = { name: trimmed, kind, defaultRateBps: bps ?? 0, categoryRatesBps };
    }
    setInvalid(bad);
    if (bad.size > 0) return;
    inFlight.current = true;
    setPending(true);
    try {
      const result =
        strategy === null
          ? await callApi('POST', TAX_STRATEGIES_PATH, body, csrfToken)
          : await callApi(
              'PUT',
              `${TAX_STRATEGIES_PATH}/${encodeURIComponent(strategy.id)}`,
              body,
              csrfToken,
            );
      if (result.ok) {
        onSaved();
        onClose();
        toast.success(t('saved'));
        return;
      }
      if (result.failure.status === 401) {
        window.location.assign('/session-ended');
        return;
      }
      if (result.failure.code === 'tax.strategy-not-found') {
        onGone();
        onClose();
        toast.error(errors('not-found'));
        return;
      }
      setProblem(errors(taxProblemOf(result.failure)));
    } finally {
      inFlight.current = false;
      setPending(false);
    }
  }

  const rateError = t('rate-invalid');
  return (
    <SettingsDrawer
      open
      title={strategy === null ? t('add-title') : t('edit-title', { name: strategy.name })}
      onClose={onClose}
      onSubmit={() => void submit()}
      pending={pending}
      dirty={snapshot() !== start}
      labels={labels}
      notice={problem === null ? undefined : <Banner tone="critical">{problem}</Banner>}
    >
      <TextField
        label={t('name')}
        value={name}
        maxLength={STRATEGY_NAME_MAX}
        error={invalid.has('name') ? t('name-required') : undefined}
        onChange={(event) => setName(event.target.value)}
      />
      <Select
        label={t('kind')}
        value={kind}
        onChange={(event) => setKind(event.target.value as StrategyKind)}
        options={(['flat-rate', 'by-category'] as const).map((value) => ({
          value,
          label: kinds(value),
        }))}
      />
      {kind === 'flat-rate' ? (
        <TextField
          label={t('rate')}
          inputMode="decimal"
          value={rate}
          help={t('rate-help')}
          error={invalid.has('rate') ? rateError : undefined}
          onChange={(event) => setRate(event.target.value)}
        />
      ) : (
        <>
          <TextField
            label={t('default-rate')}
            inputMode="decimal"
            value={defaultRate}
            help={t('default-rate-help')}
            error={invalid.has('default') ? rateError : undefined}
            onChange={(event) => setDefaultRate(event.target.value)}
          />
          {categoryCodes.length === 0 ? (
            <p className="text-sm text-fg-muted">{t('no-categories')}</p>
          ) : (
            categoryCodes.map((code) => (
              <TextField
                key={code}
                label={t('category-rate', { code })}
                inputMode="decimal"
                value={rates[code] ?? ''}
                error={invalid.has(code) ? rateError : undefined}
                onChange={(event) => setRates((all) => ({ ...all, [code]: event.target.value }))}
              />
            ))
          )}
        </>
      )}
    </SettingsDrawer>
  );
}
