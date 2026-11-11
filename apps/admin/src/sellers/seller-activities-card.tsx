'use client';

import {
  ActionRow,
  Badge,
  Banner,
  Button,
  Card,
  SearchSelect,
  TextField,
  toast,
  type SearchSelectOption,
} from '@mondapac/ui';
import { useLocale, useTranslations } from 'next-intl';
import { useRef, useState, type FormEvent } from 'react';
import type { ApiFailure } from '../api/client.ts';
import { isStepUpCancelled, useGuardedCall } from '../step-up/step-up.tsx';
import { formatInstant } from '../shared/format.ts';
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
  const [pending, setPending] = useState(false);
  const busy = useRef(false);
  const guarded = useGuardedCall();

  const nameOf = (id: string): string =>
    activities.find((a) => a.id === id)?.name ?? t('unknown-activity');
  const toOption = (id: string): SearchSelectOption => ({ value: id, label: nameOf(id) });
  // Only active activities can be picked; one the seller already carries stays visible in the read view.
  const options: SearchSelectOption[] = activities
    .filter((a) => a.active)
    .map((a) => ({ value: a.id, label: a.name }));

  function startEdit() {
    // An inactive activity cannot be saved again, so the form starts without it.
    const pickable = (id: string) => options.some((o) => o.value === id);
    setMain(
      current.mainActivityId === null || !pickable(current.mainActivityId)
        ? null
        : toOption(current.mainActivityId),
    );
    setExtras(current.extraActivityIds.filter(pickable).map(toOption));
    setReason('');
    setErrors({});
    setProblem(null);
    setEditing(true);
  }

  async function save(event: FormEvent) {
    event.preventDefault();
    if (busy.current) return;
    const next: { main?: string; reason?: string } = {};
    if (main === null) next.main = t('error.main-required');
    const trimmed = reason.trim();
    if (trimmed === '') next.reason = t('error.reason-required');
    setErrors(next);
    setProblem(null);
    if (main === null || trimmed === '') return;
    busy.current = true;
    setPending(true);
    const body = {
      mainActivityId: main.value,
      extraActivityIds: extras.map((e) => e.value).filter((id) => id !== main.value),
      reason: trimmed,
    };
    const result = await guarded<SellerActivitiesChange>(
      'PUT',
      sellerActivitiesPath(sellerId),
      body,
      csrfToken,
    );
    busy.current = false;
    setPending(false);
    if (result.ok) {
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
      toast.success(result.body.changed ? t('saved') : t('unchanged'));
      return;
    }
    if (isStepUpCancelled(result)) return;
    if (result.failure.status === 401) window.location.assign('/session-ended');
    else setProblem(problemOf(result.failure));
  }

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
        {problem === null ? null : <Banner tone="critical">{t(`error.${problem}`)}</Banner>}
        {!canEdit && editNote ? (
          <p className="text-sm text-fg-muted">{t('names-unavailable')}</p>
        ) : null}
        {canEdit && !editing ? (
          <ActionRow>
            <Button variant="secondary" onClick={startEdit}>
              {t('edit')}
            </Button>
          </ActionRow>
        ) : null}
        {canEdit && editing ? (
          <form className="flex flex-col gap-4" onSubmit={(e) => void save(e)} noValidate>
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
              <Button type="submit" loading={pending}>
                {t('save')}
              </Button>
              <Button
                variant="secondary"
                disabled={pending}
                onClick={() => {
                  setErrors({});
                  setProblem(null);
                  setEditing(false);
                }}
              >
                {t('cancel')}
              </Button>
            </ActionRow>
          </form>
        ) : null}
      </div>
    </Card>
  );
}
