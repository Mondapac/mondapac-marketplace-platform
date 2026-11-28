'use client';

import {
  ActionRow,
  Badge,
  Banner,
  Button,
  Card,
  SearchSelect,
  TextField,
  type SearchSelectOption,
} from '@mondapac/ui';
import { useLocale, useTranslations } from 'next-intl';
import { useRef, useState } from 'react';
import type { SectionResult } from '@mondapac/ui';
import type { ApiFailure } from '../api/client.ts';
import { isStepUpCancelled, useGuardedCall } from '../step-up/step-up.tsx';
import { formatInstant } from '../shared/format.ts';
import { useSellerSection } from './seller-edit-form.tsx';
import {
  EXTRA_MAX,
  REASON_MAX,
  sellerActivitiesPath,
  type ActivityOption,
  type SellerActivities,
  type SellerActivitiesChange,
} from './activities-types.ts';

const PROBLEMS: Readonly<Record<string, string>> = {
  'validation.failed': 'invalid',
  'file.not-found': 'gone',
  'access.denied': 'denied',
  'request.csrf': 'csrf',
  'sellers.unavailable': 'unavailable',
};

function problemOf(failure: ApiFailure): string {
  return (
    PROBLEMS[failure.code] ??
    (failure.status === 0 || failure.status >= 500 ? 'unavailable' : 'unknown')
  );
}

/**
 * The business activities of one seller: the main one and up to nine more, with the last change
 * and its reason. An admin with the manage key replaces the whole set with a reason; the call
 * needs a fresh two-step code, which the shared dialog asks for. The server checks every rule.
 * The edit is one part of the seller page's save bar (`SellerEditForm`).
 */
export function SellerActivitiesCard({
  sellerId,
  initial,
  activities,
  canEdit,
  editNote = false,
  csrfToken,
}: {
  readonly sellerId: string;
  readonly initial: SellerActivities;
  readonly activities: readonly ActivityOption[];
  readonly canEdit: boolean;
  /** The role may change activities but the names could not be loaded: say why there is no button. */
  readonly editNote?: boolean;
  readonly csrfToken: string;
}) {
  const t = useTranslations('sellers.activities');
  const locale = useLocale();
  const [current, setCurrent] = useState(initial);
  const [editing, setEditing] = useState(false);
  const [main, setMain] = useState<SearchSelectOption | null>(null);
  const [extras, setExtras] = useState<readonly SearchSelectOption[]>([]);
  const [reason, setReason] = useState('');
  const [errors, setErrors] = useState<{ main?: string; reason?: string }>({});
  const [problem, setProblem] = useState<string | null>(null);
  const guarded = useGuardedCall();
  const changed = useRef(false);

  const nameOf = (id: string): string =>
    activities.find((a) => a.id === id)?.name ?? t('unknown-activity');
  const toOption = (id: string): SearchSelectOption => ({ value: id, label: nameOf(id) });
  // Only active activities can be picked; one the seller already carries stays visible in the read view.
  const options: SearchSelectOption[] = activities
    .filter((a) => a.active)
    .map((a) => ({ value: a.id, label: a.name }));

  const asked = initial.requested ?? null;
  const askedSet = (): { main: string; extras: readonly string[] } | null =>
    asked === null ? null : { main: asked.mainActivityId, extras: asked.extraActivityIds };
  // The request is worth showing while it differs from what the seller carries now.
  const askedDiffers =
    asked !== null &&
    (asked.mainActivityId !== current.mainActivityId ||
      asked.extraActivityIds.join() !== current.extraActivityIds.join());

  /** Starts the edit with the seller's current set, or with the set the seller asked for. */
  function startEdit(source: { main: string | null; extras: readonly string[] } | null = null) {
    const from = source ?? { main: current.mainActivityId, extras: current.extraActivityIds };
    // An inactive activity cannot be saved again, so the form starts without it.
    const pickable = (id: string) => options.some((o) => o.value === id);
    setMain(from.main === null || !pickable(from.main) ? null : toOption(from.main));
    setExtras(from.extras.filter(pickable).map(toOption));
    // Confirming the request: the reason is filled in and can be changed.
    setReason(source === null ? '' : t('request-reason'));
    setErrors({});
    setProblem(null);
    setEditing(true);
  }

  const extraIds = (mainId: string | undefined) =>
    extras.map((e) => e.value).filter((id) => id !== mainId);
  // Dropping an inactive activity at Edit is a change too: saving removes it, and the confirm shows it.
  const dirty =
    canEdit &&
    editing &&
    (main?.value !== (current.mainActivityId ?? undefined) ||
      extraIds(main?.value).join() !== current.extraActivityIds.join() ||
      reason.trim() !== '');

  function check(): boolean {
    const next: { main?: string; reason?: string } = {};
    if (main === null) next.main = t('error.main-required');
    if (reason.trim() === '') next.reason = t('error.reason-required');
    setErrors(next);
    setProblem(null);
    return next.main === undefined && next.reason === undefined;
  }

  async function save(): Promise<SectionResult> {
    if (main === null || reason.trim() === '') return 'failed';
    const trimmed = reason.trim();
    const body = {
      mainActivityId: main.value,
      extraActivityIds: extraIds(main.value),
      reason: trimmed,
    };
    const result = await guarded<SellerActivitiesChange>(
      'PUT',
      sellerActivitiesPath(sellerId),
      body,
      csrfToken,
    );
    if (result.ok) {
      changed.current = result.body.changed;
      setCurrent({
        mainActivityId: result.body.mainActivityId,
        extraActivityIds: result.body.extraActivityIds,
        // The server holds the author and time of the change; this view shows what it knows now.
        lastChange: result.body.changed
          ? {
              changedBy: current.lastChange?.changedBy ?? '',
              changedAt: new Date().toISOString(),
              reason: trimmed,
            }
          : current.lastChange,
      });
      setEditing(false);
      return 'saved';
    }
    if (isStepUpCancelled(result)) return 'stopped';
    if (result.failure.status === 401) return section.signedOut();
    setProblem(problemOf(result.failure));
    return 'failed';
  }

  /** One confirm line: old to new, or the value unchanged. */
  function line(label: string, was: readonly string[], now: readonly string[]): string {
    const show = (names: readonly string[]) =>
      names.length === 0 ? t('confirm-none') : names.join(', ');
    return was.join() === now.join()
      ? t('confirm-same', { label, value: show(now) })
      : t('confirm-change', { label, from: show(was), to: show(now) });
  }

  function close() {
    setErrors({});
    setProblem(null);
    setEditing(false);
  }

  const section = useSellerSection('activities', {
    dirty,
    title: t('title'),
    lines: [
      line(
        t('main'),
        current.mainActivityId === null ? [] : [nameOf(current.mainActivityId)],
        main === null ? [] : [main.label],
      ),
      line(
        t('extra'),
        current.extraActivityIds.map(nameOf),
        extras.filter((e) => e.value !== main?.value).map((e) => e.label),
      ),
      ...(reason.trim() === '' ? [] : [t('confirm-reason', { reason: reason.trim() })]),
    ],
    needsCode: true,
    check,
    save,
    savedMessage: () => (changed.current ? t('saved') : t('unchanged')),
    discard: close,
  });

  return (
    <Card title={t('title')}>
      <div className="flex flex-col gap-4">
        <p className="text-sm text-fg-muted">{t('intro')}</p>
        {current.mainActivityId === null ? (
          <p className="text-fg-muted">{t('none')}</p>
        ) : (
          <div className="flex flex-col gap-2">
            <div className="flex flex-wrap items-center gap-2">
              <span className="text-fg-muted">{t('main')}:</span>
              <strong>{nameOf(current.mainActivityId)}</strong>
            </div>
            {current.extraActivityIds.length === 0 ? null : (
              <div className="flex flex-wrap items-center gap-2">
                <span className="text-fg-muted">{t('extra')}:</span>
                {current.extraActivityIds.map((id) => (
                  <Badge key={id} tone="neutral">
                    {nameOf(id)}
                  </Badge>
                ))}
              </div>
            )}
          </div>
        )}
        {current.lastChange === null ? null : (
          <p className="text-sm text-fg-muted">
            {t('last-change', {
              when: formatInstant(current.lastChange.changedAt, locale),
              reason: current.lastChange.reason,
            })}
          </p>
        )}
        {askedDiffers && asked !== null ? (
          <div className="flex flex-col gap-2 rounded-md border border-line p-3">
            <strong>{t('request-title')}</strong>
            <div className="flex flex-wrap items-center gap-2">
              <span className="text-fg-muted">{t('main')}:</span>
              <strong>{nameOf(asked.mainActivityId)}</strong>
            </div>
            {asked.extraActivityIds.length === 0 ? null : (
              <div className="flex flex-wrap items-center gap-2">
                <span className="text-fg-muted">{t('extra')}:</span>
                {asked.extraActivityIds.map((id) => (
                  <Badge key={id} tone="neutral">
                    {nameOf(id)}
                  </Badge>
                ))}
              </div>
            )}
            <p className="text-sm text-fg-muted">
              {t('request-when', { when: formatInstant(asked.requestedAt, locale) })}
            </p>
            {canEdit && !editing ? (
              <ActionRow>
                <Button
                  variant="secondary"
                  onClick={() => {
                    const set = askedSet();
                    if (set !== null) startEdit({ main: set.main, extras: set.extras });
                  }}
                >
                  {t('request-use')}
                </Button>
              </ActionRow>
            ) : null}
          </div>
        ) : null}
        {problem === null ? null : <Banner tone="critical">{t(`error.${problem}`)}</Banner>}
        {!canEdit && editNote ? (
          <p className="text-sm text-fg-muted">{t('names-unavailable')}</p>
        ) : null}
        {canEdit && !editing ? (
          <ActionRow>
            <Button variant="secondary" onClick={() => startEdit()}>
              {t('edit')}
            </Button>
          </ActionRow>
        ) : null}
        {canEdit && editing ? (
          <div className="flex flex-col gap-4">
            <SearchSelect
              label={t('field.main')}
              options={options}
              value={main}
              onChange={(next) => {
                setMain(next);
                // The main activity is not also one of the others.
                setExtras((previous) => previous.filter((e) => e.value !== next?.value));
              }}
              alwaysSearch
              required
              error={errors.main}
            />
            <SearchSelect
              multiple
              label={t('field.extra')}
              help={t('field.extra-help', { max: EXTRA_MAX })}
              options={options.filter((o) => o.value !== main?.value)}
              value={extras}
              onChange={setExtras}
              max={EXTRA_MAX}
              alwaysSearch
            />
            <TextField
              name="reason"
              label={t('field.reason')}
              help={t('field.reason-help', { max: REASON_MAX })}
              maxLength={REASON_MAX}
              value={reason}
              error={errors.reason}
              onChange={(event) => setReason(event.target.value)}
            />
            <ActionRow>
              {/* Save is the page's save bar; Cancel closes this edit and drops its draft. */}
              <Button variant="secondary" disabled={section.saving} onClick={close}>
                {t('cancel')}
              </Button>
            </ActionRow>
          </div>
        ) : null}
      </div>
    </Card>
  );
}
