'use client';

import {
  Banner,
  Button,
  Dialog,
  SearchSelect,
  Select,
  TextAreaField,
  TextField,
  toast,
  type SearchSelectLabels,
  type SearchSelectOption,
} from '@mondapac/ui';
import { useTranslations } from 'next-intl';
import { useEffect, useRef, useState } from 'react';
import { callApi } from '../api/client.ts';
import { suggestionProblemOf, type SuggestionProblem } from './suggestion-errors.ts';
import {
  API_TOPIC_SUGGESTIONS,
  NAME_MAX,
  REASON_MAX,
  type SuggestionDecided,
  type SuggestionItem,
} from './suggestion-types.ts';
import { SLUG } from './tag-form.ts';
import {
  API_TOPICS,
  SLUG_MAX,
  TOPIC_GROUPS,
  type TopicGroup,
  type TopicPage,
  type TopicRow,
} from './types.ts';

export type Decision = 'approve' | 'map' | 'reject';

/**
 * The decision on one tag suggestion, opened from the row's Actions menu (confirmation level 2: it
 * names the suggestion and what follows, the confirm button is not the focused one, and a rejection
 * needs the words the seller reads). A refused decision is told in the dialog, and a name or slug
 * that is taken offers Map to existing tag; one that went stale closes it and the list reads
 * again, with the reason said above the list.
 */
export function SuggestionDialog({
  item,
  decision,
  defaultLocale,
  languageLabel,
  csrfToken,
  onSwitch,
  onClose,
  onSettled,
}: {
  readonly item: SuggestionItem | null;
  readonly decision: Decision | null;
  readonly defaultLocale: string;
  /** The default language in words, for the help text of the name. */
  readonly languageLabel: string;
  readonly csrfToken: string;
  readonly onSwitch: (decision: Decision) => void;
  readonly onClose: () => void;
  /** The decision was made, or the suggestion turned out stale (`why` names the error key). */
  readonly onSettled: (why?: string) => void;
}) {
  const t = useTranslations('tags.suggestions');
  const cancel = useRef<HTMLButtonElement>(null);
  const busy = useRef(false);
  const ticket = useRef(0);
  const [name, setName] = useState('');
  const [group, setGroup] = useState<TopicGroup | ''>('');
  const [slug, setSlug] = useState('');
  const [reason, setReason] = useState('');
  const [chosen, setChosen] = useState<SearchSelectOption | null>(null);
  const [options, setOptions] = useState<readonly SearchSelectOption[]>([]);
  const [picker, setPicker] = useState<'loading' | 'ready' | 'failed'>('loading');
  const [noneActive, setNoneActive] = useState(false);
  const [pending, setPending] = useState(false);
  const [problem, setProblem] = useState<SuggestionProblem | null>(null);

  async function searchTags(query: string) {
    const mine = ++ticket.current;
    setPicker('loading');
    const params = new URLSearchParams({ status: 'active', limit: '25' });
    if (query.trim() !== '') params.set('search', query.trim());
    const result = await callApi<TopicPage>('GET', `${API_TOPICS}?${params.toString()}`);
    if (mine !== ticket.current) return;
    if (!result.ok) {
      if (result.failure.status === 401) {
        window.location.assign('/session-ended');
        return;
      }
      setPicker('failed');
      return;
    }
    const locale = result.body.locales.default;
    setOptions(
      result.body.items.map((row: TopicRow) => ({
        value: row.id,
        label: row.names[locale] ?? row.slug,
        description: t(`group.${row.group}`),
      })),
    );
    if (query.trim() === '') setNoneActive(result.body.items.length === 0);
    setPicker('ready');
  }

  // A new suggestion or decision starts from the seller's own words.
  useEffect(() => {
    setName(item?.label ?? '');
    setGroup('');
    setSlug(item?.suggestedSlug ?? '');
    setReason('');
    setChosen(null);
    setNoneActive(false);
    setProblem(null);
    if (decision === 'map') void searchTags('');
  }, [item?.id, decision]);

  if (item === null || decision === null) return null;

  const slugBad = slug !== '' && (slug.length > SLUG_MAX || !SLUG.test(slug));
  const ready =
    decision === 'approve'
      ? name.trim() !== '' && group !== '' && !slugBad
      : decision === 'map'
        ? chosen !== null && !noneActive
        : reason.trim() !== '';
  const fieldError = (field: string) =>
    problem?.fields.includes(field) === true ? t('field-error') : undefined;
  const selectLabels: Partial<SearchSelectLabels> = {
    search: t('picker.search'),
    noResults: t('picker.empty'),
    loading: t('picker.loading'),
    retry: t('picker.retry'),
  };

  async function submit() {
    if (busy.current || item === null || decision === null || !ready) return;
    busy.current = true;
    setPending(true);
    setProblem(null);
    const body =
      decision === 'approve'
        ? { group, name: name.trim(), ...(slug === '' ? {} : { slug }) }
        : decision === 'map'
          ? { topicId: chosen?.value }
          : { reason: reason.trim() };
    const result = await callApi<SuggestionDecided>(
      'POST',
      `${API_TOPIC_SUGGESTIONS}/${item.id}/${decision}`,
      { version: item.version, ...body },
      csrfToken,
    );
    busy.current = false;
    setPending(false);
    if (result.ok) {
      toast.success(t(`decided.${result.body.suggestion.status}`));
      onSettled();
      return;
    }
    if (result.failure.status === 401) {
      window.location.assign('/session-ended');
      return;
    }
    const next = suggestionProblemOf(result.failure);
    if (next.reload) onSettled(next.key);
    else setProblem(next);
  }

  return (
    <Dialog
      open
      size="form"
      title={t(`dialog.${decision}.title`, { label: item.label })}
      onClose={() => {
        if (!pending) onClose();
      }}
      initialFocus={cancel}
      actions={
        <>
          <Button ref={cancel} variant="secondary" disabled={pending} onClick={onClose}>
            {t('cancel')}
          </Button>
          <Button
            variant="destructive-solid"
            loading={pending}
            disabled={!ready || pending}
            onClick={() => void submit()}
          >
            {t(`dialog.${decision}.confirm`)}
          </Button>
        </>
      }
    >
      <form
        className="flex flex-col gap-3"
        noValidate
        onSubmit={(event) => {
          event.preventDefault();
          void submit();
        }}
      >
        <p className="wrap-anywhere">{t(`dialog.${decision}.body`, { label: item.label })}</p>
        {problem === null ? null : (
          <div role="alert">
            <Banner tone="critical">{t(`error.${problem.key}`)}</Banner>
            {problem.focusMap && decision === 'approve' ? (
              <p className="mt-2">
                <Button variant="secondary" disabled={pending} onClick={() => onSwitch('map')}>
                  {t('actions.map')}
                </Button>
              </p>
            ) : null}
          </div>
        )}
        {decision === 'approve' ? (
          <>
            <TextField
              name="name"
              label={t('name')}
              help={t('name-help', { language: languageLabel })}
              value={name}
              maxLength={NAME_MAX}
              lang={defaultLocale}
              autoComplete="off"
              required
              readOnly={pending}
              error={fieldError('name')}
              onChange={(event) => setName(event.target.value)}
            />
            <Select
              name="group"
              label={t('group-label')}
              placeholder={t('group-choose')}
              value={group}
              required
              disabled={pending}
              error={fieldError('group')}
              options={TOPIC_GROUPS.map((value) => ({ value, label: t(`group.${value}`) }))}
              onChange={(event) => setGroup(event.target.value as TopicGroup | '')}
            />
            <TextField
              name="slug"
              label={t('slug')}
              help={t('slug-help')}
              value={slug}
              maxLength={SLUG_MAX}
              dir="ltr"
              autoComplete="off"
              readOnly={pending}
              error={slugBad ? t('slug-bad') : fieldError('slug')}
              onChange={(event) => setSlug(event.target.value.trim().toLowerCase())}
            />
          </>
        ) : null}
        {decision === 'map' ? (
          <>
            <SearchSelect
              label={t('map-to')}
              placeholder={t('map-placeholder')}
              options={options}
              value={chosen}
              onChange={setChosen}
              onSearch={(query) => void searchTags(query)}
              alwaysSearch
              loading={picker === 'loading'}
              loadError={picker === 'failed' ? t('picker.failed') : undefined}
              onRetry={() => void searchTags('')}
              labels={selectLabels}
              disabled={pending || noneActive}
              required
            />
            {noneActive ? <p className="text-sm text-fg-muted">{t('map-none')}</p> : null}
          </>
        ) : null}
        {decision === 'reject' ? (
          <TextAreaField
            name="reason"
            label={t('reason')}
            help={t('reason-help')}
            rows={3}
            value={reason}
            maxLength={REASON_MAX}
            dir="auto"
            required
            readOnly={pending}
            counter={`${reason.length} / ${REASON_MAX}`}
            error={fieldError('reason')}
            onChange={(event) => setReason(event.target.value)}
          />
        ) : null}
      </form>
    </Dialog>
  );
}
