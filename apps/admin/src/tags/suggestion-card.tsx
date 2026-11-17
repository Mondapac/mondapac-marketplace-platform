'use client';

import {
  Badge,
  Banner,
  Button,
  SearchSelect,
  Select,
  TextAreaField,
  TextField,
  toast,
  type SearchSelectLabels,
  type SearchSelectOption,
} from '@mondapac/ui';
import { useTranslations } from 'next-intl';
import { useEffect, useRef, useState, type KeyboardEvent } from 'react';
import { callApi } from '../api/client.ts';
import { When } from '../shared/when.tsx';
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

type Mode = 'none' | 'approve' | 'map' | 'reject';
type Picker = 'loading' | 'ready' | 'failed';

/** One open tag suggestion with its three decisions as inline forms. */
export function SuggestionCard({
  item,
  defaultLocale,
  languageLabel,
  canApprove,
  csrfToken,
  onSettled,
}: {
  readonly item: SuggestionItem;
  readonly defaultLocale: string;
  /** The default language in words, for the help text of the name. */
  readonly languageLabel: string;
  readonly canApprove: boolean;
  readonly csrfToken: string;
  /** The list is read again; `why` is an error key to tell above the list. */
  readonly onSettled: (why?: string) => void;
}) {
  const t = useTranslations('tags.suggestions');
  const busy = useRef(false);
  const card = useRef<HTMLElement>(null);
  const opened = useRef(false);
  const focusMap = useRef(false);
  const [mode, setMode] = useState<Mode>('none');
  const [name, setName] = useState(item.label);
  const [group, setGroup] = useState<TopicGroup | ''>('');
  const [slug, setSlug] = useState(item.suggestedSlug);
  const [reason, setReason] = useState('');
  const [chosen, setChosen] = useState<SearchSelectOption | null>(null);
  const [options, setOptions] = useState<readonly SearchSelectOption[]>([]);
  const [picker, setPicker] = useState<Picker>('loading');
  const [noneActive, setNoneActive] = useState(false);
  const [pending, setPending] = useState(false);
  const [problem, setProblem] = useState<SuggestionProblem | null>(null);
  const ticket = useRef(0);

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

  async function decide(action: Exclude<Mode, 'none'>, body: Record<string, unknown>) {
    if (busy.current) return;
    busy.current = true;
    setPending(true);
    setProblem(null);
    const result = await callApi<SuggestionDecided>(
      'POST',
      `${API_TOPIC_SUGGESTIONS}/${item.id}/${action}`,
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
    if (next.reload) {
      onSettled(next.key);
      return;
    }
    setProblem(next);
    if (next.focusMap) {
      focusMap.current = true;
      setMode('none');
    }
  }

  // Opening a form moves focus to its first field; cancelling returns it to the first action.
  useEffect(() => {
    if (mode !== 'none') {
      opened.current = true;
      card.current?.querySelector<HTMLElement>('form input, form select, form textarea')?.focus();
    } else if (focusMap.current) {
      focusMap.current = false;
      opened.current = false;
      card.current?.querySelector<HTMLElement>('[data-action="map"]')?.focus();
    } else if (opened.current) {
      opened.current = false;
      card.current?.querySelector<HTMLElement>('button')?.focus();
    }
  }, [mode]);

  const open = (next: Exclude<Mode, 'none'>) => {
    setProblem(null);
    setMode(next);
    if (next === 'map') {
      setChosen(null);
      void searchTags('');
    }
  };
  const cancel = () => setMode('none');
  const escape = (event: KeyboardEvent<HTMLFormElement>) => {
    if (event.key === 'Escape' && !event.defaultPrevented && !pending) cancel();
  };

  const fieldError = (field: string) =>
    problem?.fields.includes(field) === true ? t('field-error') : undefined;
  const slugBad = slug !== '' && (slug.length > SLUG_MAX || !SLUG.test(slug));
  const approveBlocked = name.trim() === '' || group === '' || slugBad;
  const seller = item.sellerId.slice(0, 8);

  const selectLabels: Partial<SearchSelectLabels> = {
    search: t('picker.search'),
    noResults: t('picker.empty'),
    loading: t('picker.loading'),
    retry: t('picker.retry'),
  };

  return (
    <section
      ref={card}
      aria-labelledby={`tag-suggestion-${item.id}`}
      className="rounded-lg border border-line bg-surface p-4"
    >
      <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
        <h3
          id={`tag-suggestion-${item.id}`}
          className="min-w-0 text-base font-semibold wrap-anywhere text-fg"
        >
          “{item.label}”
        </h3>
        <Badge tone="attention">{t('open')}</Badge>
      </div>
      <p className="mt-1 flex flex-wrap gap-x-2 text-sm text-fg-muted">
        <span>{t('product', { product: item.productCode ?? t('unknown-product') })}</span>
        <span aria-hidden="true">·</span>
        <span>
          {t('seller')}{' '}
          <a className="text-link underline" href={`/sellers/${item.sellerId}`}>
            {seller}
          </a>
        </span>
        <span aria-hidden="true">·</span>
        <When iso={item.createdAt} missing="" />
      </p>
      {problem === null ? null : (
        <div className="mt-3" role="alert">
          <Banner tone="critical">{t(`error.${problem.key}`)}</Banner>
        </div>
      )}
      {mode === 'none' ? (
        <div className="mt-3 flex flex-wrap gap-3">
          <Button
            className="w-full sm:w-auto"
            aria-label={t('approve-for', { label: item.label })}
            disabled={!canApprove}
            onClick={() => open('approve')}
          >
            {t('approve')}
          </Button>
          <Button
            className="w-full sm:w-auto"
            variant="secondary"
            data-action="map"
            aria-label={t('map-for', { label: item.label })}
            onClick={() => open('map')}
          >
            {t('map')}
          </Button>
          <Button
            className="w-full sm:w-auto"
            variant="secondary"
            aria-label={t('reject-for', { label: item.label })}
            onClick={() => open('reject')}
          >
            {t('reject')}
          </Button>
          {canApprove ? null : (
            <p className="basis-full text-sm text-fg-muted">{t('approve-needs-manage')}</p>
          )}
        </div>
      ) : null}
      {mode === 'approve' ? (
        <form
          className="mt-3 flex flex-col gap-3"
          noValidate
          onKeyDown={escape}
          onSubmit={(event) => {
            event.preventDefault();
            if (approveBlocked) return;
            void decide('approve', {
              group,
              name: name.trim(),
              ...(slug === '' ? {} : { slug }),
            });
          }}
        >
          <p className="text-sm text-fg-muted">{t('approve-note')}</p>
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
          <div className="w-full sm:w-72">
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
          </div>
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
          <Actions
            busy={pending}
            disabled={approveBlocked}
            confirm={t('approve-confirm')}
            onCancel={cancel}
          />
        </form>
      ) : null}
      {mode === 'map' ? (
        <form
          className="mt-3 flex flex-col gap-3"
          noValidate
          onKeyDown={escape}
          onSubmit={(event) => {
            event.preventDefault();
            if (chosen === null) return;
            void decide('map', { topicId: chosen.value });
          }}
        >
          <div className="w-full sm:w-72">
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
          </div>
          {noneActive ? <p className="text-sm text-fg-muted">{t('map-none')}</p> : null}
          <Actions
            busy={pending}
            disabled={chosen === null || noneActive}
            confirm={t('map-confirm')}
            onCancel={cancel}
          />
        </form>
      ) : null}
      {mode === 'reject' ? (
        <form
          className="mt-3 flex flex-col gap-3"
          noValidate
          onKeyDown={escape}
          onSubmit={(event) => {
            event.preventDefault();
            if (reason.trim() === '') return;
            void decide('reject', { reason: reason.trim() });
          }}
        >
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
          <Actions
            busy={pending}
            disabled={reason.trim() === ''}
            confirm={t('reject-confirm')}
            onCancel={cancel}
          />
        </form>
      ) : null}
    </section>
  );
}

function Actions({
  busy,
  disabled,
  confirm,
  onCancel,
}: {
  readonly busy: boolean;
  readonly disabled: boolean;
  readonly confirm: string;
  readonly onCancel: () => void;
}) {
  const t = useTranslations('tags.suggestions');
  return (
    <div className="flex flex-wrap gap-3">
      <Button type="submit" className="w-full sm:w-auto" loading={busy} disabled={busy || disabled}>
        {confirm}
      </Button>
      <Button
        type="button"
        className="w-full sm:w-auto"
        variant="secondary"
        disabled={busy}
        onClick={onCancel}
      >
        {t('cancel')}
      </Button>
    </div>
  );
}
