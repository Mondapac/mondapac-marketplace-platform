'use client';

import {
  Banner,
  Button,
  LoadError,
  SaveBar,
  SettingCheckbox,
  SettingInput,
  SettingRow,
  SettingSelect,
  SettingsErrorSummary,
  SettingsPage,
  SettingsSection,
  SettingsViewOnlyBanner,
  SkeletonRows,
  toast,
  useLiveErrors,
} from '@mondapac/ui';
import { useLocale, useTranslations } from 'next-intl';
import { useCallback, useEffect, useRef, useState } from 'react';
import { callApi } from '../api/client.ts';
import { useSettingsChrome } from '../settings/settings-chrome.ts';
import { formatInstant } from '../shared/format.ts';
import { formatMinor } from '../wallet/money.ts';
import { isStepUpCancelled, useGuardedCall } from '../step-up/step-up.tsx';
import { promotionsProblemOf } from './errors.ts';
import {
  checkFirstOrder,
  decimalOf,
  firstOrderChanges,
  firstOrderDraftOf,
  zoneChanges,
  zoneDraftsOf,
  ZONE_CODE,
  type FirstOrderDraft,
  type FirstOrderField,
  type ZoneDraft,
} from './form.ts';
import {
  FIRST_ORDER_PATH,
  SWITCH_PATH,
  THRESHOLDS_PATH,
  thresholdPath,
  type DiscountKind,
  type FirstOrderView,
  type MarketSwitch,
  type Thresholds,
} from './types.ts';

const P = 'promotionsSettings';
const KINDS: readonly DiscountKind[] = ['PERCENT', 'FIXED'];
const ROW: Readonly<Record<FirstOrderField, string>> = {
  percent: 'setting-first-order-percent',
  amount: 'setting-first-order-amount',
  cap: 'setting-first-order-cap',
  minSpend: 'setting-first-order-min-spend',
  budget: 'setting-first-order-budget',
};

type Loaded =
  | { readonly state: 'loading' }
  | { readonly state: 'failed' }
  | {
      readonly state: 'ready';
      readonly firstOrder: FirstOrderView;
      readonly thresholds: Thresholds;
    };

/**
 * Settings → Promotions: the Market switch, the first-order discount and the free-delivery
 * threshold per zone, on one page with one save bar. The switch comes with the page; the other
 * two are read here, because the API answers `promotions.disabled` for them while the Market is
 * off. A save writes what changed, one request each; the response drives the screen.
 */
export function PromotionsSettingsPanel({
  initial,
  canManageSwitch,
  canManagePromotions,
  csrfToken,
}: {
  readonly initial: MarketSwitch;
  readonly canManageSwitch: boolean;
  /** Holds `promotions.promotion.manage`: the first-order and free-delivery cards are there. */
  readonly canManagePromotions: boolean;
  readonly csrfToken: string;
}) {
  const t = useTranslations();
  const locale = useLocale();
  const chrome = useSettingsChrome();
  const guarded = useGuardedCall();
  const [saved, setSaved] = useState<MarketSwitch>(initial);
  const [wantOn, setWantOn] = useState(initial.status === 'active');
  const [loaded, setLoaded] = useState<Loaded>({ state: 'loading' });
  const [first, setFirst] = useState<FirstOrderDraft | null>(null);
  const [zones, setZones] = useState<readonly ZoneDraft[]>([]);
  const [newZone, setNewZone] = useState('');
  const [newZoneError, setNewZoneError] = useState(false);
  const [saving, setSaving] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const busy = useRef(false);

  const active = saved.status === 'active';
  const showCards = canManagePromotions && active;

  const load = useCallback(async () => {
    setLoaded({ state: 'loading' });
    const [order, shipping] = await Promise.all([
      callApi<FirstOrderView>('GET', FIRST_ORDER_PATH),
      callApi<Thresholds>('GET', THRESHOLDS_PATH),
    ]);
    if (order.ok && shipping.ok) {
      setLoaded({ state: 'ready', firstOrder: order.body, thresholds: shipping.body });
      setFirst(firstOrderDraftOf(order.body.settings, order.body.currency));
      setZones(zoneDraftsOf(shipping.body));
      return;
    }
    for (const result of [order, shipping]) {
      if (!result.ok && result.failure.status === 401) {
        window.location.assign('/session-ended');
        return;
      }
    }
    setLoaded({ state: 'failed' });
  }, []);

  useEffect(() => {
    if (showCards) void load();
  }, [showCards, load]);

  const ready = loaded.state === 'ready' ? loaded : null;
  const currency = ready?.firstOrder.currency ?? 'AUD';
  const money = (minor: string) => formatMinor(minor, currency, locale);

  const check = first === null ? null : checkFirstOrder(first, currency);
  const firstChanged =
    ready === null || first === null
      ? []
      : firstOrderChanges(ready.firstOrder.settings, first, currency);
  const zoneWrites = ready === null ? [] : zoneChanges(ready.thresholds, zones);
  const invalidZones = new Set(
    zoneWrites.filter((write) => 'invalid' in write).map((write) => write.zoneCode),
  );
  // A zone typed wrongly counts as one unsaved change that fails; so does an invalid discount.
  const changeCount = (wantOn !== active ? 1 : 0) + firstChanged.length + zoneWrites.length;
  const failing: readonly FirstOrderField[] =
    firstChanged.length > 0 && check !== null && !check.ok ? check.invalid : [];
  const live = useLiveErrors<FirstOrderField>(failing);
  const shownErrors = live.shown;
  const errorCount = shownErrors.length + invalidZones.size;
  const readOnlySwitch = !canManageSwitch;

  const patchFirst = (patch: Partial<FirstOrderDraft>) =>
    setFirst((current) => (current === null ? current : { ...current, ...patch }));
  const patchZone = (zoneCode: string, patch: Partial<ZoneDraft>) =>
    setZones((current) =>
      current.map((zone) => (zone.zoneCode === zoneCode ? { ...zone, ...patch } : zone)),
    );

  function discard() {
    setWantOn(active);
    if (ready !== null) {
      setFirst(firstOrderDraftOf(ready.firstOrder.settings, currency));
      setZones(zoneDraftsOf(ready.thresholds));
    }
    setNewZone('');
    setNewZoneError(false);
    setProblem(null);
    live.reset();
  }

  function addZone() {
    const code = newZone.trim();
    if (!ZONE_CODE.test(code)) {
      setNewZoneError(true);
      return;
    }
    setNewZoneError(false);
    if (!zones.some((zone) => zone.zoneCode === code) && ready !== null) {
      setZones((current) => [
        ...current,
        {
          zoneCode: code,
          own: true,
          value: decimalOf(ready.thresholds.defaultThresholdMinor, currency),
        },
      ]);
    }
    setNewZone('');
  }

  async function submit() {
    if (busy.current || changeCount === 0) return;
    setProblem(null);
    if (invalidZones.size > 0 || (firstChanged.length > 0 && check !== null && !check.ok)) {
      live.attempt();
      return;
    }
    busy.current = true;
    setSaving(true);
    try {
      await save();
    } finally {
      busy.current = false;
      setSaving(false);
    }
  }

  /** One request each; the first refusal stops the rest and what was saved stays saved. */
  async function save() {
    type Step<T> = { path: string; body: unknown; apply: (body: T) => void };
    const steps: Step<never>[] = [];
    if (ready !== null && first !== null && firstChanged.length > 0 && check?.ok === true) {
      steps.push({
        path: FIRST_ORDER_PATH,
        body: check.body,
        apply: (body: FirstOrderView) => {
          setLoaded((current) =>
            current.state === 'ready' ? { ...current, firstOrder: body } : current,
          );
          setFirst(firstOrderDraftOf(body.settings, body.currency));
        },
      });
    }
    for (const write of zoneWrites) {
      if ('invalid' in write) continue;
      steps.push({
        path: thresholdPath(write.zoneCode),
        body: { thresholdMinor: write.thresholdMinor },
        apply: (body: { zoneCode: string; thresholdMinor: string | null }) => {
          setLoaded((current) => {
            if (current.state !== 'ready') return current;
            const others = current.thresholds.zones.filter(
              (zone) => zone.zoneCode !== body.zoneCode,
            );
            const zonesNow =
              body.thresholdMinor === null
                ? others
                : [...others, { zoneCode: body.zoneCode, thresholdMinor: body.thresholdMinor }];
            return { ...current, thresholds: { ...current.thresholds, zones: zonesNow } };
          });
          if (body.thresholdMinor === null) {
            setZones((current) => current.filter((zone) => zone.zoneCode !== body.zoneCode));
          } else {
            patchZone(body.zoneCode, {
              own: true,
              value: decimalOf(body.thresholdMinor, currency),
            });
          }
        },
      });
    }
    // The switch last, so turning promotions off never leaves a card unsaved behind it.
    if (wantOn !== active) {
      steps.push({
        path: SWITCH_PATH,
        body: { status: wantOn ? 'active' : 'off' },
        apply: (body: MarketSwitch) => setSaved(body),
      });
    }
    for (const step of steps) {
      const result = await guarded<never>('PUT', step.path, step.body, csrfToken);
      if (!result.ok) {
        if (isStepUpCancelled(result)) return;
        if (result.failure.status === 401) {
          window.location.assign('/session-ended');
          return;
        }
        const key = promotionsProblemOf(result.failure);
        if (key === 'disabled') {
          setSaved({ status: 'off', updatedAt: saved.updatedAt });
          setWantOn(false);
        }
        setProblem(key);
        return;
      }
      step.apply(result.body);
    }
    live.reset();
    toast.success(t(`${P}.notice.saved`));
  }

  const summaryLabel = (field: FirstOrderField) => t(`${P}.first-order.field.${field}`);
  const errorOf = (field: FirstOrderField) =>
    shownErrors.includes(field) ? t(`${P}.first-order.invalid.${field}`) : undefined;

  const banners = [
    canManageSwitch && canManagePromotions ? null : (
      <SettingsViewOnlyBanner key="view-only" title={t('settings.view-only.title')}>
        {canManageSwitch ? t(`${P}.view-only-cards`) : t('settings.view-only.body')}
      </SettingsViewOnlyBanner>
    ),
    errorCount === 0 ? null : (
      <SettingsErrorSummary
        key="invalid"
        title={t('settings.errors.title', { count: errorCount })}
        items={[
          ...shownErrors.map((field) => ({
            id: ROW[field],
            label: summaryLabel(field),
            reason: errorOf(field),
          })),
          ...[...invalidZones].map((zone) => ({
            id: `setting-zone-${zone}`,
            label: zone,
            reason: t(`${P}.zones.invalid`),
          })),
        ]}
        focusSignal={live.attempts}
      />
    ),
    problem === null ? null : (
      <Banner key="problem" tone="critical">
        {t(`${P}.error.${problem}`)}
      </Banner>
    ),
  ].filter((node) => node !== null);

  const switchChanged = wantOn !== active;
  const canSave = canManageSwitch || canManagePromotions;
  const lastChanged =
    saved.updatedAt === null
      ? undefined
      : {
          text: t(`${P}.last-changed`, { when: formatInstant(saved.updatedAt, locale) }),
          dateTime: saved.updatedAt,
        };

  return (
    <SettingsPage
      title={t(`${P}.title`)}
      description={t(`${P}.intro`)}
      lastChanged={lastChanged}
      banner={
        banners.length === 0 ? undefined : <div className="flex flex-col gap-3">{banners}</div>
      }
      onSubmit={canSave ? () => void submit() : undefined}
      dirty={canSave && changeCount > 0}
      dirtyCount={changeCount}
      leave={chrome.leave}
      saveBar={
        canSave ? (
          <SaveBar
            {...chrome.saveBar({
              count: changeCount,
              errorCount,
              saving,
              onDiscard: discard,
            })}
          />
        ) : null
      }
    >
      <SettingsSection title={t(`${P}.switch.title`)} description={t(`${P}.switch.intro`)}>
        <SettingRow
          id="setting-promotions-switch"
          settingId="promotions-switch"
          label={t(`${P}.switch.label`)}
          help={t(`${P}.switch.help`)}
          changed={switchChanged}
          disabled={readOnlySwitch}
        >
          <SettingCheckbox
            name="promotions-on"
            text={wantOn ? t(`${P}.state.on`) : t(`${P}.state.off`)}
            checked={wantOn}
            onChange={(event) => setWantOn(event.target.checked)}
          />
        </SettingRow>
      </SettingsSection>

      {!canManagePromotions ? null : !active ? (
        <SettingsSection title={t(`${P}.off.title`)}>
          <div className="px-5 py-4">
            <Banner tone="info">{t(`${P}.off.body`)}</Banner>
          </div>
        </SettingsSection>
      ) : loaded.state === 'loading' ? (
        <SkeletonRows label={t(`${P}.loading`)} rows={3} />
      ) : loaded.state === 'failed' || first === null ? (
        <LoadError
          className="flex flex-col items-start gap-3"
          message={t(`${P}.load-failed`)}
          retryLabel={t('load.retry')}
          onRetry={() => void load()}
        />
      ) : (
        <>
          <SettingsSection
            title={t(`${P}.first-order.title`)}
            description={t(`${P}.first-order.intro`)}
          >
            <SettingRow
              settingId="first-order-enabled"
              label={t(`${P}.first-order.field.enabled`)}
              changed={firstChanged.includes('enabled')}
            >
              <SettingCheckbox
                name="first-order-enabled"
                text={first.enabled ? t(`${P}.state.on`) : t(`${P}.state.off`)}
                checked={first.enabled}
                onChange={(event) => patchFirst({ enabled: event.target.checked })}
              />
            </SettingRow>
            <SettingRow
              label={t(`${P}.first-order.field.kind`)}
              changed={firstChanged.includes('kind')}
            >
              <SettingSelect
                name="first-order-kind"
                options={KINDS.map((kind) => ({
                  value: kind,
                  label: t(`${P}.first-order.kind.${kind}`),
                }))}
                value={first.kind}
                onChange={(event) => patchFirst({ kind: event.target.value as DiscountKind })}
              />
            </SettingRow>
            {first.kind === 'PERCENT' ? (
              <>
                <SettingRow
                  id={ROW.percent}
                  label={t(`${P}.first-order.field.percent`)}
                  help={t(`${P}.first-order.help.percent`)}
                  changed={firstChanged.includes('percent')}
                  error={errorOf('percent')}
                >
                  <SettingInput
                    name="first-order-percent"
                    inputMode="decimal"
                    autoComplete="off"
                    className="md:max-w-40"
                    value={first.percent}
                    onChange={(event) => patchFirst({ percent: event.target.value })}
                    onBlur={() => live.touch('percent')}
                  />
                </SettingRow>
                <SettingRow
                  id={ROW.cap}
                  label={t(`${P}.first-order.field.cap`)}
                  optionalLabel={t(`${P}.optional`)}
                  help={t(`${P}.first-order.help.cap`)}
                  changed={firstChanged.includes('cap')}
                  error={errorOf('cap')}
                >
                  <SettingInput
                    name="first-order-cap"
                    inputMode="decimal"
                    autoComplete="off"
                    className="md:max-w-40"
                    prefix={currency}
                    value={first.cap}
                    onChange={(event) => patchFirst({ cap: event.target.value })}
                    onBlur={() => live.touch('cap')}
                  />
                </SettingRow>
              </>
            ) : (
              <SettingRow
                id={ROW.amount}
                label={t(`${P}.first-order.field.amount`)}
                changed={firstChanged.includes('amount')}
                error={errorOf('amount')}
              >
                <SettingInput
                  name="first-order-amount"
                  inputMode="decimal"
                  autoComplete="off"
                  className="md:max-w-40"
                  prefix={currency}
                  value={first.amount}
                  onChange={(event) => patchFirst({ amount: event.target.value })}
                  onBlur={() => live.touch('amount')}
                />
              </SettingRow>
            )}
            <SettingRow
              id={ROW.minSpend}
              label={t(`${P}.first-order.field.minSpend`)}
              help={t(`${P}.first-order.help.minSpend`)}
              changed={firstChanged.includes('minSpend')}
              error={errorOf('minSpend')}
            >
              <SettingInput
                name="first-order-min-spend"
                inputMode="decimal"
                autoComplete="off"
                className="md:max-w-40"
                prefix={currency}
                value={first.minSpend}
                onChange={(event) => patchFirst({ minSpend: event.target.value })}
                onBlur={() => live.touch('minSpend')}
              />
            </SettingRow>
            <SettingRow
              id={ROW.budget}
              label={t(`${P}.first-order.field.budget`)}
              help={t(`${P}.first-order.help.budget`)}
              changed={firstChanged.includes('budget')}
              error={errorOf('budget')}
            >
              <SettingInput
                name="first-order-budget"
                inputMode="decimal"
                autoComplete="off"
                className="md:max-w-40"
                prefix={currency}
                value={first.budget}
                onChange={(event) => patchFirst({ budget: event.target.value })}
                onBlur={() => live.touch('budget')}
              />
            </SettingRow>
          </SettingsSection>

          <SettingsSection title={t(`${P}.zones.title`)} description={t(`${P}.zones.intro`)}>
            <SettingRow label={t(`${P}.zones.default`)} help={t(`${P}.zones.default-help`)} plain>
              <p data-testid="default-threshold" className="text-fg">
                {money(ready?.thresholds.defaultThresholdMinor ?? '0')}
              </p>
            </SettingRow>
            {zones.map((zone) => (
              <SettingRow
                key={zone.zoneCode}
                id={`setting-zone-${zone.zoneCode}`}
                label={zone.zoneCode}
                help={zone.own ? undefined : t(`${P}.zones.uses-default`)}
                changed={zoneWrites.some((write) => write.zoneCode === zone.zoneCode)}
                error={invalidZones.has(zone.zoneCode) ? t(`${P}.zones.invalid`) : undefined}
              >
                <div className="flex items-center gap-2">
                  {zone.own ? (
                    <SettingInput
                      name={`zone-${zone.zoneCode}`}
                      inputMode="decimal"
                      autoComplete="off"
                      className="md:max-w-40"
                      prefix={currency}
                      aria-label={t(`${P}.zones.threshold-for`, { zone: zone.zoneCode })}
                      value={zone.value}
                      onChange={(event) => patchZone(zone.zoneCode, { value: event.target.value })}
                    />
                  ) : null}
                  <Button
                    type="button"
                    variant="secondary"
                    onClick={() =>
                      patchZone(
                        zone.zoneCode,
                        zone.own
                          ? { own: false }
                          : {
                              own: true,
                              value: decimalOf(
                                ready?.thresholds.defaultThresholdMinor ?? '0',
                                currency,
                              ),
                            },
                      )
                    }
                  >
                    {zone.own ? t(`${P}.zones.use-default`) : t(`${P}.zones.set-own`)}
                  </Button>
                </div>
              </SettingRow>
            ))}
            <SettingRow
              label={t(`${P}.zones.add`)}
              help={t(`${P}.zones.add-help`)}
              error={newZoneError ? t(`${P}.zones.code-invalid`) : undefined}
            >
              <div className="flex items-center gap-2">
                <SettingInput
                  name="new-zone"
                  autoComplete="off"
                  className="md:max-w-48"
                  value={newZone}
                  onChange={(event) => setNewZone(event.target.value)}
                />
                <Button type="button" variant="secondary" onClick={addZone}>
                  {t(`${P}.zones.add-button`)}
                </Button>
              </div>
            </SettingRow>
          </SettingsSection>
        </>
      )}
    </SettingsPage>
  );
}
