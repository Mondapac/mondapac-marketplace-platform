'use client';

import {
  Badge,
  Banner,
  Button,
  CARD_TABLE,
  Dialog,
  LoadError,
  SaveBar,
  Select,
  SettingsPage,
  SettingsSection,
  SettingsSkeleton,
  Switch,
  TextField,
  toast,
  useDelayedLoading,
} from '@mondapac/ui';
import { useLocale, useTranslations } from 'next-intl';
import { useCallback, useEffect, useRef, useState } from 'react';
import { callApi } from '../api/client.ts';
import { dayInZone } from '../shared/format.ts';
import { ReviewNoteField, trimmedNote } from '../shared/review-note.tsx';
import { isStepUpCancelled, useGuardedCall } from '../step-up/step-up.tsx';
import { isFieldFailure, notifyChanged, refusalOf, shortCode, type Refusal } from './errors.ts';
import { RefusalBanner } from './refusal-banner.tsx';
import {
  BASE,
  POLICY_AREAS,
  RISKS,
  requestPath,
  type AreaPolicy,
  type PolicyChange,
  type RecordedRequest,
  type RequestPage,
  type ReviewPolicy,
  type Risk,
} from './types.ts';

/** The subject kind of a policy area's requests (confirmed against the API's recorder). */
export const POLICY_AREA_KIND = 'system-requests.policy-area';

interface AreaDraft {
  readonly enabled: boolean;
  readonly risk: Risk;
}

/** One change to save: an area's switch and risk, or the review period. */
type Item =
  { readonly kind: 'area'; readonly area: AreaPolicy['area'] } | { readonly kind: 'days' };

interface Pending {
  readonly id: string;
  readonly number: number;
}

const DAYS_MIN = 1;
const DAYS_MAX = 90;

/**
 * Settings > People > Review policy: which areas are reviewed and at what risk, and how many days
 * an open request waits before it is overdue. A change goes live at once and opens a high-risk
 * review request, so each one is saved with a note and a two-step code, one at a time. Without
 * the manage permission every control is read-only.
 */
export function ReviewPolicyPanel({
  canManage,
  canSeeRequests,
  csrfToken,
  zone,
}: {
  readonly canManage: boolean;
  /** The admin may open requests: the pending badges are read, and link to them. */
  readonly canSeeRequests: boolean;
  readonly csrfToken: string;
  readonly zone: string;
}) {
  const t = useTranslations('system-requests.policy');
  const tr = useTranslations('system-requests');
  const root = useTranslations();
  const locale = useLocale();
  const guarded = useGuardedCall();
  const [policy, setPolicy] = useState<ReviewPolicy | null>(null);
  const [loadFailed, setLoadFailed] = useState(false);
  const [drafts, setDrafts] = useState<Readonly<Record<string, AreaDraft>>>({});
  const [days, setDays] = useState<string | null>(null);
  const [pending, setPending] = useState<Readonly<Record<string, Pending>>>({});
  const [saving, setSaving] = useState<Item | null>(null);
  const [note, setNote] = useState('');
  const [noteError, setNoteError] = useState<'required' | 'rejected' | null>(null);
  const [daysError, setDaysError] = useState(false);
  const [busy, setBusy] = useState(false);
  const [conflict, setConflict] = useState(false);
  const [refusal, setRefusal] = useState<Refusal | null>(null);
  const attempt = useRef(0);
  const inFlight = useRef(false);
  const loading = useDelayedLoading(policy === null && !loadFailed);

  const load = useCallback(async () => {
    const mine = ++attempt.current;
    setLoadFailed(false);
    const result = await callApi<ReviewPolicy>('GET', `${BASE}/review-policy`);
    if (mine !== attempt.current) return;
    if (result.ok) {
      setPolicy(result.body);
      return;
    }
    if (result.failure.status === 401) window.location.assign('/session-ended');
    else setLoadFailed(true);
  }, []);

  /** The open review requests of the policy areas, for the "Awaiting review" badges. */
  const loadPending = useCallback(async () => {
    if (!canSeeRequests) return;
    const result = await callApi<RequestPage>(
      'GET',
      `${BASE}/requests?view=all&status=open&subjectKind=${POLICY_AREA_KIND}&pageSize=100&sort=number&direction=desc`,
    );
    if (!result.ok) return;
    const next: Record<string, Pending> = {};
    for (const row of result.body.rows) {
      // Newest first: the first open request of an area is the one shown.
      if (next[row.subjectRef] === undefined) {
        next[row.subjectRef] = { id: row.id, number: row.number };
      }
    }
    setPending(next);
  }, [canSeeRequests]);

  useEffect(() => {
    void load();
    void loadPending();
  }, [load, loadPending]);

  useEffect(() => {
    if (!loading.stalled) return;
    attempt.current += 1;
    setLoadFailed(true);
  }, [loading.stalled]);

  const title = t('title');
  if (loadFailed) {
    return (
      <SettingsPage title={title} description={t('intro')}>
        <LoadError
          className="flex flex-col items-start gap-3"
          message={t('load-failed')}
          retryLabel={root('load.retry')}
          onRetry={() => void load()}
        />
      </SettingsPage>
    );
  }
  if (policy === null || loading.visible) {
    return (
      <SettingsPage title={title} description={t('intro')}>
        <SettingsSkeleton
          label={root('route.loading-page', { page: title })}
          header={false}
          sections={[{ fields: 3 }, { fields: 7 }, { fields: 1 }]}
          visible={loading.visible}
          slow={loading.slow}
          slowLabel={root('route.slow')}
        />
      </SettingsPage>
    );
  }

  const serverArea = (area: string) => policy.areas.find((entry) => entry.area === area);
  const draftOf = (row: AreaPolicy): AreaDraft => drafts[row.area] ?? row;
  const areaDirty = (row: AreaPolicy) => {
    const draft = drafts[row.area];
    return draft !== undefined && (draft.enabled !== row.enabled || draft.risk !== row.risk);
  };
  const daysNumber = days === null ? null : Number(days);
  const daysDirty = days !== null && Number(days) !== policy.reviewDueDays.reviewDueDays;
  const daysInvalid =
    days !== null &&
    (days.trim() === '' ||
      !Number.isInteger(daysNumber) ||
      (daysNumber ?? 0) < DAYS_MIN ||
      (daysNumber ?? 0) > DAYS_MAX);

  const items: readonly Item[] = [
    ...policy.areas.filter(areaDirty).map((row): Item => ({ kind: 'area', area: row.area })),
    ...(daysDirty && !daysInvalid ? [{ kind: 'days' as const }] : []),
  ];
  const changeCount = items.length + (daysDirty && daysInvalid ? 1 : 0);

  const setDraft = (row: AreaPolicy, patch: Partial<AreaDraft>) =>
    setDrafts((current) => ({ ...current, [row.area]: { ...draftOf(row), ...patch } }));
  const discard = () => {
    setDrafts({});
    setDays(null);
    setDaysError(false);
  };

  const riskName = (risk: string) => tr(`risk.${risk}`);

  /** The line that says what the change is: "Money: review on, risk High to Medium". */
  const summaryOf = (item: Item): string => {
    if (item.kind === 'days') {
      return t('summary.days', {
        from: policy.reviewDueDays.reviewDueDays,
        to: Number(days),
      });
    }
    const row = serverArea(item.area);
    const draft = drafts[item.area];
    if (row === undefined || draft === undefined) return '';
    const parts = [
      draft.enabled !== row.enabled
        ? t(draft.enabled ? 'summary.turned-on' : 'summary.turned-off')
        : t(draft.enabled ? 'summary.review-on' : 'summary.review-off'),
      draft.risk !== row.risk
        ? t('summary.risk-change', { from: riskName(row.risk), to: riskName(draft.risk) })
        : t('summary.risk', { risk: riskName(draft.risk) }),
    ];
    return `${tr(`area.${item.area}`)}: ${parts.join(', ')}`;
  };

  const turnsOff = (item: Item): boolean => {
    if (item.kind !== 'area') return false;
    const row = serverArea(item.area);
    const draft = drafts[item.area];
    return row !== undefined && draft !== undefined && row.enabled && !draft.enabled;
  };

  const startSaving = () => {
    const first = items[0];
    if (first === undefined) return;
    setNoteError(null);
    setRefusal(null);
    setSaving(first);
  };

  async function send(item: Item) {
    if (inFlight.current) return;
    const text = trimmedNote(note);
    if (text === null) {
      setNoteError('required');
      return;
    }
    inFlight.current = true;
    setBusy(true);
    setNoteError(null);
    setConflict(false);
    setRefusal(null);
    const row = item.kind === 'area' ? serverArea(item.area) : undefined;
    const draft = item.kind === 'area' ? drafts[item.area] : undefined;
    const result =
      item.kind === 'area' && row !== undefined && draft !== undefined
        ? await guarded<PolicyChange<AreaPolicy>>(
            'PUT',
            `${BASE}/review-policy/areas/${item.area}`,
            {
              enabled: draft.enabled,
              risk: draft.risk,
              expectedVersion: row.version,
              note: text,
            },
            csrfToken,
          )
        : await guarded<PolicyChange<ReviewPolicy['reviewDueDays']>>(
            'PUT',
            `${BASE}/review-policy/review-due-days`,
            {
              reviewDueDays: Number(days),
              expectedVersion: policy?.reviewDueDays.version ?? 0,
              note: text,
            },
            csrfToken,
          );
    inFlight.current = false;
    setBusy(false);
    if (result.ok) {
      announce(result.body.request);
      applySaved(item, result.body.value, result.body.request);
      return;
    }
    // The code dialog was closed: this dialog stays open, as it was.
    if (isStepUpCancelled(result)) return;
    const { failure } = result;
    if (failure.status === 401) {
      window.location.assign('/session-ended');
      return;
    }
    if (isFieldFailure(failure, 'note')) {
      setNoteError('rejected');
      return;
    }
    if (isFieldFailure(failure, 'reviewDueDays')) {
      setSaving(null);
      setDaysError(true);
      return;
    }
    if (shortCode(failure.code) === 'policy-conflict') {
      // Someone saved first: show the latest values, keep the note, say so.
      setSaving(null);
      setConflict(true);
      await load();
      return;
    }
    setSaving(null);
    setRefusal(refusalOf(failure));
  }

  function announce(request: RecordedRequest | null) {
    if (request === null) {
      toast.info(t('toast.nothing'));
      return;
    }
    toast.success(t('toast.saved', { number: request.displayNumber }), {
      ...(canSeeRequests
        ? {
            action: {
              label: t('toast.open'),
              onClick: () => window.location.assign(requestPath(request.id)),
            },
          }
        : {}),
    });
    notifyChanged();
  }

  function applySaved(
    item: Item,
    value: AreaPolicy | ReviewPolicy['reviewDueDays'],
    request: RecordedRequest | null,
  ) {
    setPolicy((current) => {
      if (current === null) return current;
      return item.kind === 'area'
        ? {
            ...current,
            areas: current.areas.map((entry) =>
              entry.area === item.area ? (value as AreaPolicy) : entry,
            ),
          }
        : { ...current, reviewDueDays: value as ReviewPolicy['reviewDueDays'] };
    });
    if (item.kind === 'area') {
      setDrafts((current) =>
        Object.fromEntries(Object.entries(current).filter(([area]) => area !== item.area)),
      );
      if (request !== null) {
        setPending((current) => ({
          ...current,
          [item.area]: { id: request.id, number: request.number },
        }));
      }
    } else setDays(null);
    setNote('');
    // The next change waits for its own note and code.
    const rest = items.filter((entry) => JSON.stringify(entry) !== JSON.stringify(item));
    setSaving(rest[0] ?? null);
  }

  const saveBar = canManage ? (
    <SaveBar
      count={changeCount}
      summary={t('bar.summary', { count: changeCount })}
      errorCount={daysDirty && daysInvalid ? 1 : 0}
      errorsSummary={t('bar.errors', { count: daysDirty && daysInvalid ? 1 : 0 })}
      saving={busy}
      labels={{
        region: t('bar.region'),
        discard: t('bar.discard'),
        save: t('bar.save'),
        saving: t('bar.saving'),
      }}
      onDiscard={discard}
    />
  ) : undefined;

  const banners = [
    <Banner key="always" tone="info">
      <p>{t('always-reviewed')}</p>
      <p className="mt-1 text-xs">
        {t('reviewer-key')} <code>{policy.reviewPolicy.reviewPermission}</code>
      </p>
    </Banner>,
    canManage ? null : (
      <Banner key="view-only" tone="info">
        {t('view-only')}
      </Banner>
    ),
    conflict ? (
      <Banner key="conflict" tone="attention">
        {t('conflict')}
      </Banner>
    ) : null,
    refusal === null ? null : <RefusalBanner key="refusal" refusal={refusal} />,
  ].filter((node) => node !== null);

  const changedBy = (at: string | null, name?: string | null) =>
    at === null
      ? t('default')
      : t('last-changed', {
          name: name !== undefined && name !== null && name.trim() !== '' ? name : tr('admin'),
          date: dayInZone(at, locale, zone),
        });

  const { cell, labelled } = CARD_TABLE;
  const current = saving;

  return (
    <SettingsPage
      title={title}
      description={t('intro')}
      banner={<div className="flex flex-col gap-3">{banners}</div>}
      onSubmit={canManage ? startSaving : undefined}
      dirty={canManage && changeCount > 0}
      dirtyCount={changeCount}
      leave={{
        title: t('leave.title'),
        message: (info) => t('leave.message', { count: info.count, page: info.page }),
        stay: t('leave.stay'),
        leave: t('leave.leave'),
      }}
      saveBar={saveBar}
    >
      <SettingsSection title={t('areas.title')} description={t('areas.description')}>
        <div className="overflow-x-auto">
          <table className={CARD_TABLE.table}>
            <caption className="sr-only">{t('areas.title')}</caption>
            <thead className={CARD_TABLE.head}>
              <tr>
                <th scope="col" className="px-4 py-3 text-start font-medium">
                  {t('col.area')}
                </th>
                <th scope="col" className="px-4 py-3 text-start font-medium">
                  {t('col.review')}
                </th>
                <th scope="col" className="px-4 py-3 text-start font-medium">
                  {t('col.risk')}
                </th>
                <th scope="col" className="px-4 py-3 text-start font-medium">
                  {t('col.permission')}
                </th>
                <th scope="col" className="px-4 py-3 text-start font-medium">
                  {t('col.changed')}
                </th>
                <th scope="col" className="px-4 py-3 text-start font-medium">
                  {t('col.pending')}
                </th>
              </tr>
            </thead>
            <tbody className={CARD_TABLE.body}>
              {POLICY_AREAS.map((area) => {
                const row = serverArea(area);
                if (row === undefined) return null;
                const draft = draftOf(row);
                const dirty = areaDirty(row);
                const waiting = pending[area];
                const name = tr(`area.${area}`);
                return (
                  <tr key={area} className={`${CARD_TABLE.row} ${dirty ? 'bg-selected' : ''}`}>
                    <th scope="row" className={`${cell} text-start font-normal`}>
                      <span className="font-medium text-fg">{name}</span>
                      {dirty ? (
                        <span className="ms-2 text-xs font-medium text-attention-fg">
                          {t('unsaved')}
                        </span>
                      ) : null}
                      <span className="mt-0.5 block text-fg-muted">{t(`area-help.${area}`)}</span>
                      {area === 'money' ? (
                        <span className="mt-0.5 block text-xs text-fg-muted">
                          {t('money-note')}
                        </span>
                      ) : null}
                    </th>
                    <td className={labelled} data-label={t('col.review')}>
                      <Switch
                        aria-label={t('review-switch', { area: name })}
                        checked={draft.enabled}
                        disabled={!canManage}
                        aria-disabled={!canManage}
                        onCheckedChange={(enabled) => setDraft(row, { enabled })}
                      />
                    </td>
                    <td className={labelled} data-label={t('col.risk')}>
                      <div className="w-36 [&_label]:sr-only">
                        <Select
                          label={t('risk-select', { area: name })}
                          value={draft.risk}
                          disabled={!canManage || !draft.enabled}
                          aria-disabled={!canManage || !draft.enabled}
                          options={RISKS.map((risk) => ({ value: risk, label: riskName(risk) }))}
                          onChange={(event) => setDraft(row, { risk: event.target.value as Risk })}
                        />
                      </div>
                    </td>
                    <td className={labelled} data-label={t('col.permission')}>
                      <code className="break-all text-xs">{row.reviewPermission}</code>
                    </td>
                    <td className={labelled} data-label={t('col.changed')}>
                      {changedBy(row.version === 0 ? null : row.updatedAt, row.updatedByName)}
                    </td>
                    <td className={labelled} data-label={t('col.pending')}>
                      {waiting === undefined ? (
                        <span className="text-fg-muted">{tr('none')}</span>
                      ) : (
                        <a href={requestPath(waiting.id)} className="no-underline">
                          <Badge tone="info">
                            {t('awaiting', { number: `SR-${waiting.number}` })}
                          </Badge>
                        </a>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </SettingsSection>
      <SettingsSection title={t('period.title')}>
        <div className="flex max-w-(--mp-size-form-max) flex-col gap-2 px-5 py-4">
          <TextField
            type="number"
            name="reviewDueDays"
            label={t('period.label')}
            help={t('period.help')}
            min={DAYS_MIN}
            max={DAYS_MAX}
            inputMode="numeric"
            value={days ?? String(policy.reviewDueDays.reviewDueDays)}
            disabled={!canManage}
            error={daysInvalid || daysError ? t('period.error') : undefined}
            onChange={(event) => {
              setDays(event.target.value);
              setDaysError(false);
            }}
          />
          <p className="text-xs text-fg-muted">
            {changedBy(
              policy.reviewDueDays.version === 0 ? null : policy.reviewDueDays.updatedAt,
              policy.reviewDueDays.updatedByName,
            )}
          </p>
        </div>
      </SettingsSection>
      {current === null ? null : (
        <Dialog
          open
          title={t('dialog.title')}
          onClose={() => {
            if (!busy) setSaving(null);
          }}
          actions={
            <>
              <Button variant="secondary" disabled={busy} onClick={() => setSaving(null)}>
                {t('dialog.cancel')}
              </Button>
              <Button loading={busy} onClick={() => void send(current)}>
                {t('dialog.confirm')}
              </Button>
            </>
          }
        >
          <div className="flex flex-col gap-3">
            <p className="font-medium text-fg">{summaryOf(current)}</p>
            {turnsOff(current) ? <p>{t('dialog.turning-off')}</p> : null}
            <Banner tone="attention">{t('dialog.warning')}</Banner>
            <ReviewNoteField
              value={note}
              onChange={(next) => {
                setNote(next);
                setNoteError(null);
              }}
              error={noteError ?? undefined}
            />
          </div>
        </Dialog>
      )}
    </SettingsPage>
  );
}
