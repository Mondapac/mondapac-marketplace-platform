'use client';

import {
  Banner,
  Button,
  CheckboxRow,
  FormActionBar,
  Select,
  TextAreaField,
  TextField,
} from '@mondapac/ui';
import { useLocale, useTranslations } from 'next-intl';
import { useRouter } from 'next/navigation';
import { useEffect, useRef, useState, type FormEvent, type ReactNode } from 'react';
import { callApi } from '../../api/client.ts';
import { shortInstantInZone } from '../../shared/format.ts';
import {
  EMPTY_FORM,
  carriedOf,
  countOf,
  currentVersion,
  defaultCarried,
  formOf,
  isLinkType,
  mapProblems,
  requestOf,
  sameForm,
  validate,
  type FieldCode,
  type FieldErrors,
  type FormField,
  type SlideFormState,
} from './slide-form.ts';
import { SlideEditorHeader } from './slide-editor-header.tsx';
import { usePositionLabel } from './slide-labels.tsx';
import { SlidePreview } from './slide-preview.tsx';
import {
  ALT_MAX,
  BODY_MAX,
  CTA_MAX,
  DEFAULT_POSITION,
  DEFAULT_WINDOW_DAYS,
  IMAGE_KEYS,
  LINK_TYPES,
  NAME_MAX,
  SLIDE_KINDS,
  SLIDES_API_PATH,
  SLIDES_PATH,
  TITLE_MAX,
  type SlideDetail,
} from './slide-types.ts';

const MAX: Partial<Record<FormField, number>> = {
  internalName: NAME_MAX,
  title: TITLE_MAX,
  body: BODY_MAX,
  ctaLabel: CTA_MAX,
  alt: ALT_MAX,
};

type Problem = { readonly tone: 'fields' | 'text'; readonly text: string } | null;

/** "24 / 60" under a field, in the critical colour once the text is too long. */
function Hint({
  text,
  value,
  max,
  counter,
}: {
  readonly text: string;
  readonly value: string;
  readonly max: number;
  /** The counter's words for a count ("24 / 60"). */
  readonly counter: (count: number) => string;
}) {
  const count = countOf(value);
  return (
    <span className="flex items-start justify-between gap-x-3">
      <span className="min-w-0">{text}</span>
      <span className={`shrink-0 ${count > max ? 'text-critical-fg' : ''}`}>{counter(count)}</span>
    </span>
  );
}

/**
 * The Content tab of a slide: type, internal name, headline, text, button, what it opens, the
 * picture and the Sponsored label, with a live preview. `slide` is absent on /new. Without the
 * edit permission (or on an archived slide) the form is read-only and has no Save bar.
 */
export function SlideEditor({
  slide,
  canEdit,
  csrfToken,
  zone,
  canPause = false,
  canPublish = false,
  startReview = false,
}: {
  readonly slide: SlideDetail | null;
  readonly canEdit: boolean;
  /** storefront.slide.pause: Pause is offered. */
  readonly canPause?: boolean;
  /** storefront.slide.publish: Review and approve and Resume are offered. */
  readonly canPublish?: boolean;
  /** The list's Review link: the approval dialog opens at once. */
  readonly startReview?: boolean;
  readonly csrfToken: string;
  /** The IANA zone dates are shown in. */
  readonly zone: string;
}) {
  const t = useTranslations('content.slides.editor');
  const locale = useLocale();
  const router = useRouter();
  const positionLabel = usePositionLabel();
  const formRef = useRef<HTMLFormElement>(null);
  const inFlight = useRef(false);
  const [detail, setDetail] = useState<SlideDetail | null>(slide);
  const [baseline, setBaseline] = useState<SlideFormState>(() =>
    slide === null ? EMPTY_FORM : formOf(slide),
  );
  const [form, setForm] = useState<SlideFormState>(baseline);
  const [errors, setErrors] = useState<FieldErrors>({});
  const [problem, setProblem] = useState<Problem>(null);
  const [saved, setSaved] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const [focusRequest, setFocusRequest] = useState(0);

  const archived = detail?.status === 'archived';
  const editable = canEdit && !archived;
  const creating = detail === null;
  const dirty = !sameForm(form, baseline);
  const tone = (detail === null ? null : currentVersion(detail)?.content?.textTone) ?? 'light';

  // After a refused save the first marked field takes focus, so the reason is read at once.
  useEffect(() => {
    if (focusRequest === 0) return;
    formRef.current?.querySelector<HTMLElement>('[aria-invalid="true"]')?.focus();
  }, [focusRequest]);

  function change(patch: Partial<SlideFormState>, ...fields: FormField[]) {
    setForm((previous) => ({ ...previous, ...patch }));
    setSaved(null);
    if (fields.length > 0) {
      setErrors((previous) => {
        const next = { ...previous };
        for (const field of fields) delete next[field];
        return next;
      });
    }
  }

  function messageFor(field: FormField, code: FieldCode): string {
    if (field === 'alt' && code === 'required') return t('error.alt-required');
    if (field === 'linkType' && code === 'required') return t('error.link-type-required');
    if (field === 'linkId' && code === 'format') {
      return form.linkType === 'search' ? t('error.link-id-search') : t('error.link-id-uuid');
    }
    return t(`error.${code}`, { max: MAX[field] ?? 0 });
  }
  const errorOf = (field: FormField): string | undefined => {
    const code = errors[field];
    return code === undefined ? undefined : messageFor(field, code);
  };

  function failWith(found: FieldErrors) {
    setErrors(found);
    setProblem({ tone: 'fields', text: t('error.summary') });
    setFocusRequest((n) => n + 1);
  }

  async function save(event?: FormEvent) {
    event?.preventDefault();
    if (!editable || inFlight.current) return;
    setProblem(null);
    setSaved(null);
    const found = validate(form);
    if (Object.keys(found).length > 0) {
      failWith(found);
      return;
    }
    setErrors({});
    const carried = detail === null ? defaultCarried(new Date()) : carriedOf(detail);
    if (carried === null) {
      setProblem({ tone: 'text', text: t('error.generic') });
      return;
    }
    inFlight.current = true;
    setPending(true);
    try {
      const body = requestOf(form, carried, creating);
      const result = creating
        ? await callApi<SlideDetail>('POST', SLIDES_API_PATH, body, csrfToken)
        : await callApi<SlideDetail>('PUT', `${SLIDES_API_PATH}/${detail.id}`, body, csrfToken);
      if (result.ok) {
        if (creating) {
          router.push(`${SLIDES_PATH}/${result.body.id}`);
          return;
        }
        const next = formOf(result.body);
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
        const mapped = mapProblems(failure.details?.fields ?? []);
        if (Object.keys(mapped.fields).length > 0) {
          failWith(mapped.fields);
        } else {
          setProblem({
            tone: 'text',
            text: mapped.other.length > 0 ? t('error.window') : t('error.generic'),
          });
        }
        return;
      }
      const text =
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
                  : t('error.generic');
      setProblem({ tone: 'text', text });
    } finally {
      inFlight.current = false;
      setPending(false);
    }
  }

  function discard() {
    setForm(baseline);
    setErrors({});
    setProblem(null);
    setSaved(null);
  }

  const version = detail === null ? null : currentVersion(detail);
  const span =
    version === null
      ? null
      : t('where-window', {
          from: shortInstantInZone(version.startsAt, locale, zone),
          to: shortInstantInZone(version.endsAt, locale, zone),
        });
  const positions = [...new Set((version?.placements ?? []).map((p) => p.position))];

  return (
    <div className="flex flex-col gap-4">
      <SlideEditorHeader
        slide={detail}
        tab="content"
        commands={{
          gates: { edit: canEdit, pause: canPause, publish: canPublish },
          csrfToken,
          zone,
          unsaved: dirty,
          startReview,
          onChange: setDetail,
        }}
      />
      {!canEdit ? <Banner tone="info">{t('read-only')}</Banner> : null}
      {canEdit && archived ? <Banner tone="info">{t('archived')}</Banner> : null}
      {creating && canEdit ? (
        <Banner tone="info">
          {t('new-note', {
            position: positionLabel(DEFAULT_POSITION),
            days: DEFAULT_WINDOW_DAYS,
          })}
        </Banner>
      ) : null}
      <div className="grid items-start gap-6 xl:grid-cols-[minmax(0,1fr)_minmax(0,28rem)]">
        <form
          ref={formRef}
          aria-label={t('form')}
          noValidate
          onSubmit={(event) => void save(event)}
          className="flex min-w-0 flex-col gap-4"
        >
          {problem === null ? null : <Banner tone="critical">{problem.text}</Banner>}
          <fieldset
            disabled={!editable}
            className="m-0 flex min-w-0 flex-col gap-5 rounded-lg border border-line bg-surface p-4 sm:p-6"
          >
            <KindPicker form={form} locked={!creating} onPick={(kind) => change({ kind })} />
            <div className="grid gap-5 sm:grid-cols-2">
              <TextField
                label={t('name')}
                value={form.internalName}
                autoComplete="off"
                error={errorOf('internalName')}
                help={
                  <Hint
                    text={t('name-help')}
                    value={form.internalName}
                    max={NAME_MAX}
                    counter={(count) => t('counter', { count, max: NAME_MAX })}
                  />
                }
                onChange={(event) => change({ internalName: event.target.value }, 'internalName')}
              />
              <TextField
                label={t('title')}
                value={form.title}
                autoComplete="off"
                error={errorOf('title')}
                help={
                  <Hint
                    text={t('title-help')}
                    value={form.title}
                    max={TITLE_MAX}
                    counter={(count) => t('counter', { count, max: TITLE_MAX })}
                  />
                }
                onChange={(event) => change({ title: event.target.value }, 'title')}
              />
            </div>
            <TextAreaField
              label={t('body')}
              optionalLabel={t('optional')}
              rows={3}
              value={form.body}
              error={errorOf('body')}
              help={
                <Hint
                  text={t('body-help')}
                  value={form.body}
                  max={BODY_MAX}
                  counter={(count) => t('counter', { count, max: BODY_MAX })}
                />
              }
              onChange={(event) => change({ body: event.target.value }, 'body')}
            />
            <div className="grid gap-5 sm:grid-cols-2">
              <TextField
                label={t('cta')}
                optionalLabel={t('optional')}
                value={form.ctaLabel}
                autoComplete="off"
                error={errorOf('ctaLabel')}
                help={
                  <Hint
                    text={t('cta-help')}
                    value={form.ctaLabel}
                    max={CTA_MAX}
                    counter={(count) => t('counter', { count, max: CTA_MAX })}
                  />
                }
                onChange={(event) => change({ ctaLabel: event.target.value }, 'ctaLabel')}
              />
              <Select
                label={t('opens')}
                placeholder={t('opens-none')}
                value={form.linkType}
                error={errorOf('linkType')}
                help={t('opens-help')}
                options={LINK_TYPES.map((type) => ({ value: type, label: t(`link.${type}`) }))}
                onChange={(event) => {
                  const value = event.target.value;
                  change(
                    { linkType: isLinkType(value) ? value : '', linkId: '' },
                    'linkType',
                    'linkId',
                    'ctaLabel',
                  );
                }}
              />
            </div>
            {form.linkType === '' ? null : (
              <TextField
                label={t(`link-id.${form.linkType}`)}
                value={form.linkId}
                autoComplete="off"
                spellCheck={false}
                error={errorOf('linkId')}
                help={t(`link-id-help.${form.linkType === 'search' ? 'search' : 'uuid'}`)}
                onChange={(event) => change({ linkId: event.target.value }, 'linkId')}
              />
            )}
            <Select
              label={t('image')}
              placeholder={t('image-none')}
              value={form.imageRef}
              error={errorOf('imageRef')}
              help={t('image-help')}
              options={IMAGE_KEYS.map((key) => ({ value: key, label: t(`image-key.${key}`) }))}
              onChange={(event) => change({ imageRef: event.target.value }, 'imageRef', 'alt')}
            />
            {form.imageRef === '' ? null : (
              <TextField
                label={t('alt')}
                value={form.alt}
                autoComplete="off"
                error={errorOf('alt')}
                help={
                  <Hint
                    text={t('alt-help')}
                    value={form.alt}
                    max={ALT_MAX}
                    counter={(count) => t('counter', { count, max: ALT_MAX })}
                  />
                }
                onChange={(event) => change({ alt: event.target.value }, 'alt')}
              />
            )}
            <CheckboxRow
              label={t('sponsored')}
              help={t('sponsored-help')}
              checked={form.sponsored}
              onChange={(event) => change({ sponsored: event.target.checked })}
            />
          </fieldset>
          {detail === null ? null : (
            <p className="text-sm text-fg-muted">
              {positions.length === 0
                ? t('where-none')
                : t('where', {
                    positions: positions.map(positionLabel).join(', '),
                    window: span ?? '',
                    zone,
                  })}
            </p>
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
        </form>
        <div className="min-w-0 xl:sticky xl:top-20">
          <SlidePreview form={form} tone={tone} />
        </div>
      </div>
    </div>
  );
}

/** The three slide types as radio cards; the type is chosen once, when the slide is created. */
function KindPicker({
  form,
  locked,
  onPick,
}: {
  readonly form: SlideFormState;
  readonly locked: boolean;
  readonly onPick: (kind: (typeof SLIDE_KINDS)[number]) => void;
}): ReactNode {
  const t = useTranslations('content.slides.editor');
  const tk = useTranslations('content.slides.kind');
  const th = useTranslations('content.slides.kind-help');
  if (locked) {
    // An existing slide keeps its type: a plain line, not three disabled cards whose chosen one
    // is hard to see in the dark theme.
    return <p className="text-sm text-fg">{t('kind-fixed', { kind: tk(form.kind) })}</p>;
  }
  return (
    <fieldset className="m-0 min-w-0 border-0 p-0 @container">
      <legend className="mb-1.5 p-0 text-sm font-medium text-fg">{t('kind')}</legend>
      <div className="grid gap-3 @lg:grid-cols-3">
        {SLIDE_KINDS.map((kind) => (
          <label
            key={kind}
            className="flex min-w-0 cursor-pointer items-start gap-3 rounded-md border border-line-input bg-surface p-3 has-checked:border-accent has-checked:bg-selected has-focus-visible:outline-2 has-focus-visible:outline-focus"
          >
            <input
              type="radio"
              name="slide-kind"
              value={kind}
              checked={form.kind === kind}
              onChange={() => onPick(kind)}
              className="mt-1 size-4 shrink-0 accent-accent"
            />
            <span className="min-w-0">
              <span className="block text-sm font-medium text-fg">{tk(kind)}</span>
              <span className="block text-sm text-fg-muted">{th(kind)}</span>
            </span>
          </label>
        ))}
      </div>
    </fieldset>
  );
}
