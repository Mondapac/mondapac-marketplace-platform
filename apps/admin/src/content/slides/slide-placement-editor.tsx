'use client';

import {
  Badge,
  Banner,
  Button,
  CheckboxRow,
  FormActionBar,
  Icon,
  Select,
  TextField,
} from '@mondapac/ui';
import { useTranslations } from 'next-intl';
import { useRouter } from 'next/navigation';
import { useEffect, useRef, useState, type FormEvent } from 'react';
import { callApi } from '../../api/client.ts';
import { SlideEditorHeader } from './slide-editor-header.tsx';
import { positionMessageKey, usePositionLabel } from './slide-labels.tsx';
import {
  clearErrors,
  hasErrors,
  liveCounts,
  mapPlacementProblems,
  placementFormOf,
  placementRequestOf,
  placementsOf,
  samePlacementForm,
  validatePlacement,
  type PlacementErrors,
  type PlacementFormState,
  type RowState,
} from './slide-placement.ts';
import {
  MAX_WINDOW_DAYS,
  SLIDE_POSITIONS,
  SLIDES_API_PATH,
  type SlideDetail,
  type SlideList,
  type SlideScope,
  type SlideSummary,
} from './slide-types.ts';

type Problem = string | null;
/** What is known of the live slides: still loading, loaded, or the list could not be read. */
type Live =
  | { readonly state: 'loading' }
  | { readonly state: 'failed' }
  | {
      readonly state: 'ready';
      readonly slides: readonly SlideSummary[];
    };

const isScope = (value: string, allowed: readonly SlideScope[]): value is SlideScope =>
  (allowed as readonly string[]).includes(value);

/**
 * The Where and when tab of a slide: the positions it appears at (with how many places are taken),
 * where on those pages, and its window and pin. The whole draft is saved again, with the content
 * as it was. Without the edit permission (or on an archived slide) it is read-only.
 */
export function SlidePlacementEditor({
  slide,
  canEdit,
  csrfToken,
  zone,
}: {
  readonly slide: SlideDetail;
  readonly canEdit: boolean;
  readonly csrfToken: string;
  /** The IANA zone of the Market, which the date fields are read in. */
  readonly zone: string;
}) {
  const t = useTranslations('content.slides.placement');
  const router = useRouter();
  const positionLabel = usePositionLabel();
  const formRef = useRef<HTMLFormElement>(null);
  const inFlight = useRef(false);
  const [detail, setDetail] = useState<SlideDetail>(slide);
  const [baseline, setBaseline] = useState<PlacementFormState>(() => placementFormOf(slide, zone));
  const [form, setForm] = useState<PlacementFormState>(baseline);
  const [errors, setErrors] = useState<PlacementErrors>({ rows: {} });
  const [problem, setProblem] = useState<Problem>(null);
  const [saved, setSaved] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const [focusRequest, setFocusRequest] = useState(0);
  const [live, setLive] = useState<Live>({ state: 'loading' });

  const archived = detail.status === 'archived';
  const editable = canEdit && !archived;
  const dirty = !samePlacementForm(form, baseline);

  // The live slides, for "n of max live". Without them the rows still work; the API checks the
  // places again when the slide is approved.
  useEffect(() => {
    let current = true;
    void callApi<SlideList>('GET', `${SLIDES_API_PATH}?state=live`).then((result) => {
      if (!current) return;
      setLive(
        result?.ok === true ? { state: 'ready', slides: result.body.slides } : { state: 'failed' },
      );
    });
    return () => {
      current = false;
    };
  }, []);

  useEffect(() => {
    if (focusRequest === 0) return;
    formRef.current?.querySelector<HTMLElement>('[aria-invalid="true"]')?.focus();
  }, [focusRequest]);

  const others = live.state === 'ready' ? liveCounts(live.slides, detail.id) : null;
  const selfLiveAt = (key: string): boolean =>
    detail.status === 'live' && (detail.live?.placements ?? []).some((p) => p.position === key);
  const taken = (key: string): number | null =>
    others === null ? null : (others[key] ?? 0) + (selfLiveAt(key) ? 1 : 0);
  const full = (key: string): boolean => {
    const row = form.rows[key];
    const max = SLIDE_POSITIONS.find((position) => position.key === key)?.max ?? 0;
    return row?.on === true && others !== null && !selfLiveAt(key) && (others[key] ?? 0) >= max;
  };
  const fullKeys = SLIDE_POSITIONS.map((position) => position.key).filter(full);

  function edit(patch: Partial<PlacementFormState>, field?: 'startsAt' | 'endsAt') {
    setForm((previous) => ({ ...previous, ...patch }));
    setSaved(null);
    if (field !== undefined) setErrors((previous) => clearErrors(previous, { field }));
  }

  function editRow(key: string, patch: Partial<RowState>) {
    setForm((previous) => {
      const row = previous.rows[key];
      return row === undefined
        ? previous
        : { ...previous, rows: { ...previous.rows, [key]: { ...row, ...patch } } };
    });
    setSaved(null);
    setErrors((previous) => clearErrors(previous, { row: key }));
  }

  function failWith(found: PlacementErrors) {
    setErrors(found);
    setProblem(t('error.summary'));
    setFocusRequest((n) => n + 1);
  }

  async function save(event?: FormEvent) {
    event?.preventDefault();
    if (!editable || inFlight.current) return;
    setProblem(null);
    setSaved(null);
    const found = validatePlacement(form, zone);
    if (hasErrors(found)) {
      failWith(found);
      return;
    }
    setErrors({ rows: {} });
    const body = placementRequestOf(detail, form, zone);
    if (body === null) {
      setProblem(t('error.generic'));
      return;
    }
    inFlight.current = true;
    setPending(true);
    try {
      const result = await callApi<SlideDetail>(
        'PUT',
        `${SLIDES_API_PATH}/${detail.id}`,
        body,
        csrfToken,
      );
      if (result.ok) {
        const next = placementFormOf(result.body, zone);
        setDetail(result.body);
        setBaseline(next);
        setForm(next);
        setSaved(t('saved', { version: result.body.draft?.versionNo ?? 0 }));
        return;
      }
      const failure = result.failure;
      if (failure.status === 401) {
        router.replace('/session-ended');
        return;
      }
      if (failure.code === 'validation.failed') {
        const mapped = mapPlacementProblems(failure.details?.fields ?? [], placementsOf(form).keys);
        if (hasErrors(mapped.errors)) failWith(mapped.errors);
        else setProblem(mapped.other > 0 ? t('error.other') : t('error.generic'));
        return;
      }
      setProblem(
        failure.code === 'network'
          ? t('error.network')
          : failure.code === 'storefront.slide-archived'
            ? t('error.archived')
            : failure.code === 'storefront.slide-version-limit'
              ? t('error.version-limit')
              : failure.code === 'storefront.slide-not-found'
                ? t('error.not-found')
                : failure.status === 403
                  ? t('error.denied')
                  : t('error.generic'),
      );
    } finally {
      inFlight.current = false;
      setPending(false);
    }
  }

  function discard() {
    setForm(baseline);
    setErrors({ rows: {} });
    setProblem(null);
    setSaved(null);
  }

  const windowMessage = (field: 'startsAt' | 'endsAt'): string | undefined => {
    const code = errors[field];
    if (code === undefined) return undefined;
    if (code === 'before-start') return t('error.before-start');
    if (code === 'too-long') return t('error.too-long', { days: MAX_WINDOW_DAYS });
    if (code === 'required' && field === 'endsAt') return t('error.end-required');
    return field === 'startsAt' ? t('error.start-format') : t('error.end-format');
  };

  return (
    <div className="flex flex-col gap-4">
      <SlideEditorHeader slide={detail} tab="placement" />
      {!canEdit ? <Banner tone="info">{t('read-only')}</Banner> : null}
      {canEdit && archived ? <Banner tone="info">{t('archived')}</Banner> : null}
      {problem === null ? null : <Banner tone="critical">{problem}</Banner>}
      <form
        ref={formRef}
        aria-label={t('form')}
        noValidate
        onSubmit={(event) => void save(event)}
        className="grid items-start gap-6 xl:grid-cols-[minmax(0,1fr)_minmax(0,24rem)]"
      >
        <section
          aria-labelledby="placement-where"
          className="min-w-0 rounded-lg border border-line bg-surface p-4 sm:p-6"
        >
          <h2 id="placement-where" className="text-base font-semibold">
            {t('where-title')}
          </h2>
          <p className="mb-2 text-sm text-fg-muted">{t('where-help')}</p>
          <fieldset
            disabled={!editable}
            aria-describedby={errors.none === true ? 'placement-none' : undefined}
            className="m-0 min-w-0 border-0 p-0"
          >
            <legend className="sr-only">{t('positions')}</legend>
            {errors.none === true ? (
              <p id="placement-none" className="mb-2 text-sm text-critical-fg">
                {t('error.none')}
              </p>
            ) : null}
            <ul className="m-0 flex list-none flex-col p-0">
              {SLIDE_POSITIONS.map((position) => {
                const row = form.rows[position.key];
                if (row === undefined) return null;
                const count = taken(position.key);
                const isFull = count !== null && count >= position.max;
                return (
                  <PositionRow
                    key={position.key}
                    positionKey={position.key}
                    label={positionLabel(position.key)}
                    max={position.max}
                    autoplay={position.autoplay}
                    scopes={position.scopes}
                    row={row}
                    count={count}
                    full={isFull}
                    errors={errors}
                    onChange={(patch) => editRow(position.key, patch)}
                  />
                );
              })}
            </ul>
            {live.state === 'failed' ? (
              <p className="mt-2 text-sm text-fg-muted">{t('capacity-note-unavailable')}</p>
            ) : null}
            {form.others.length > 0 ? (
              <p className="mt-2 text-sm text-fg-muted">
                {t('others-kept', { count: form.others.length })}
              </p>
            ) : null}
          </fieldset>
          <div className="mt-4 flex items-start gap-2 rounded-md border border-dashed border-line-input bg-subtle p-3 text-sm text-fg-muted">
            <span className="mt-0.5 shrink-0">
              <Icon name="lock" />
            </span>
            <span className="min-w-0">{t('locked')}</span>
          </div>
        </section>
        <div className="flex min-w-0 flex-col gap-4">
          <section
            aria-labelledby="placement-when"
            className="rounded-lg border border-line bg-surface p-4 sm:p-6"
          >
            <h2 id="placement-when" className="mb-4 text-base font-semibold">
              {t('when-title')}
            </h2>
            <fieldset disabled={!editable} className="m-0 flex min-w-0 flex-col gap-4 border-0 p-0">
              <TextField
                label={t('starts')}
                type="datetime-local"
                value={form.startsAt}
                error={windowMessage('startsAt')}
                onChange={(event) => edit({ startsAt: event.target.value }, 'startsAt')}
              />
              <TextField
                label={t('ends')}
                type="datetime-local"
                value={form.endsAt}
                error={windowMessage('endsAt')}
                help={t('ends-help', { days: MAX_WINDOW_DAYS })}
                onChange={(event) => edit({ endsAt: event.target.value }, 'endsAt')}
              />
              <p className="text-sm text-fg-muted">{t('zone', { zone })}</p>
              <CheckboxRow
                label={t('pin')}
                help={t('pin-help')}
                checked={form.pinned}
                onChange={(event) => edit({ pinned: event.target.checked })}
              />
            </fieldset>
          </section>
          {fullKeys.length === 0 ? null : (
            <Banner tone="attention">
              {t(fullKeys.length === 1 ? 'full-alert' : 'full-alert-many', {
                positions: fullKeys.map(positionLabel).join(', '),
              })}
            </Banner>
          )}
          {editable ? (
            <div className="sticky bottom-0 z-10 -mx-4 bg-page px-4 pb-4 sm:static sm:mx-0 sm:bg-transparent sm:px-0 sm:pb-0">
              <FormActionBar
                status={
                  <>
                    <span role="status" aria-live="polite" className="block">
                      {saved}
                    </span>
                    <span className="block">{t('approval-note')}</span>
                  </>
                }
              >
                <Button variant="secondary" disabled={!dirty || pending} onClick={discard}>
                  {t('discard')}
                </Button>
                <Button type="submit" loading={pending}>
                  {t('save')}
                </Button>
              </FormActionBar>
            </div>
          ) : null}
        </div>
      </form>
    </div>
  );
}

function PositionRow({
  positionKey,
  label,
  max,
  autoplay,
  scopes,
  row,
  count,
  full,
  errors,
  onChange,
}: {
  readonly positionKey: string;
  readonly label: string;
  readonly max: number;
  readonly autoplay: boolean;
  readonly scopes: readonly SlideScope[];
  readonly row: RowState;
  /** Places taken now, or null while it is not known. */
  readonly count: number | null;
  readonly full: boolean;
  readonly errors: PlacementErrors;
  readonly onChange: (patch: Partial<RowState>) => void;
}) {
  const t = useTranslations('content.slides.placement');
  const key = positionMessageKey(positionKey);
  const checkId = `position-${key}`;
  const helpId = `${checkId}-help`;
  const rowErrors = errors.rows[positionKey];
  const scopeIdError =
    rowErrors?.scopeId === undefined
      ? undefined
      : rowErrors.scopeId === 'required'
        ? t('error.required')
        : rowErrors.scopeId === 'format'
          ? t('error.id-uuid')
          : t('error.invalid');
  return (
    <li
      aria-label={label}
      className="flex flex-col gap-3 border-t border-line py-4 first:border-t-0 first:pt-0"
    >
      <div className="flex flex-wrap items-start justify-between gap-x-4 gap-y-2">
        <div className="flex min-w-0 flex-1 basis-56 items-start gap-3">
          <input
            id={checkId}
            type="checkbox"
            checked={row.on}
            aria-describedby={helpId}
            aria-invalid={errors.none === true ? true : undefined}
            onChange={(event) => onChange({ on: event.target.checked })}
            className="mt-1 size-4 shrink-0 accent-accent"
          />
          <div className="flex min-w-0 flex-col gap-1">
            <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
              <label htmlFor={checkId} className="text-sm font-medium text-fg">
                {label}
              </label>
              {autoplay ? <Badge tone="neutral">{t('tag-autoplay')}</Badge> : null}
            </div>
            <p id={helpId} className="text-sm text-fg-muted">
              {t(`help.${key}`)}
            </p>
          </div>
        </div>
        <span className="shrink-0 ps-7 text-sm text-fg-muted sm:ps-0">
          {count === null ? (
            <>
              <span aria-hidden="true">{'—'}</span>
              <span className="sr-only">{t('capacity-unknown')}</span>
            </>
          ) : full ? (
            <Badge tone="attention">{t('capacity-full', { count, max })}</Badge>
          ) : (
            t('capacity', { count, max })
          )}
        </span>
      </div>
      {row.on && (scopes.length > 1 || row.extra.length > 0) ? (
        <div className="grid gap-3 ps-7 sm:grid-cols-2">
          {scopes.length > 1 ? (
            <Select
              label={t('scope.label')}
              value={row.scope}
              options={scopes.map((scope) => ({ value: scope, label: t(`scope.${scope}`) }))}
              onChange={(event) => {
                const value = event.target.value;
                onChange({
                  scope: isScope(value, scopes) ? value : 'all',
                  scopeId: '',
                  includeSubcategories: false,
                });
              }}
            />
          ) : null}
          {row.scope === 'all' ? null : (
            <div className="sm:col-span-2">
              <TextField
                label={t(`scope-id.${row.scope}`)}
                value={row.scopeId}
                autoComplete="off"
                spellCheck={false}
                error={scopeIdError}
                help={t('scope-id-help')}
                onChange={(event) => onChange({ scopeId: event.target.value })}
              />
            </div>
          )}
          {row.scope === 'category' ? (
            <div className="sm:col-span-2">
              <CheckboxRow
                label={t('subcategories')}
                checked={row.includeSubcategories}
                onChange={(event) => onChange({ includeSubcategories: event.target.checked })}
              />
            </div>
          ) : null}
          {row.extra.length > 0 ? (
            <p className="text-sm text-fg-muted sm:col-span-2">
              {t('more-kept', { count: row.extra.length })}
            </p>
          ) : null}
        </div>
      ) : null}
    </li>
  );
}
