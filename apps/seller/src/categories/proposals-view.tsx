'use client';

import {
  Badge,
  Banner,
  Button,
  Card,
  EmptyState,
  Select,
  TextAreaField,
  TextField,
} from '@mondapac/ui';
import type { BadgeTone } from '@mondapac/ui';
import { useTranslations } from 'next-intl';
import { useRef, useState } from 'react';
import { callApi } from '../api/client.ts';
import {
  isRtl,
  localeName,
  nameOf,
  orderedLocales,
  parentOptions,
  proposalProblemOf,
  textsBody,
  type FilledText,
  type ProposeProblem,
} from './logic.ts';
import type {
  CategoryLocales,
  OwnProposal,
  OwnProposals,
  OwnShelf,
  ParentCategory,
} from './types.ts';

const NAME_MAX = 80;
const DESCRIPTION_MAX = 160;
const STATUS_TONE: Record<string, BadgeTone> = {
  pending: 'attention',
  approved: 'success',
  rejected: 'neutral',
  cancelled: 'neutral',
};
const STATUSES = ['pending', 'approved', 'rejected', 'cancelled'];
const REASONS = [
  'already-exists',
  'too-narrow',
  'too-broad',
  'misleading',
  'not-sold-here',
  'other',
  'seller-cancelled',
  'permission-revoked',
];

const reload = (suffix = '') => window.location.assign(`/category-proposals${suffix}`);

/**
 * "Suggest a category" (categories C9b; CAT-51 to CAT-54): propose a shelf of the seller's own shop
 * under a platform category, see the proposals and their outcome, withdraw a waiting one, and list
 * the shelves. A shelf is never a platform category. Every seller-typed text is rendered as text.
 */
export function ProposalsView({
  data,
  parents,
  locales,
  csrfToken,
  sent,
}: {
  readonly data: OwnProposals;
  readonly parents: readonly ParentCategory[];
  readonly locales: CategoryLocales;
  readonly csrfToken: string;
  readonly sent: boolean;
}) {
  const t = useTranslations('categories.proposals');
  const options = parentOptions(parents, locales.default);
  const labelOf = new Map(options.map((option) => [option.value, option.label]));
  const waiting = data.proposals.filter((proposal) => proposal.status === 'pending').length;
  const full = waiting >= data.maxPending;
  return (
    <div className="flex flex-col gap-6">
      <p className="max-w-(--mp-size-form-max) text-sm text-fg-muted">{t('intro')}</p>
      {sent ? <Banner tone="success">{t('sent')}</Banner> : null}
      {data.canPropose ? (
        <>
          <p className="text-sm font-medium" data-testid="pending-count">
            {t('waiting', { count: waiting, max: data.maxPending })}
          </p>
          {full ? (
            <Banner tone="info">{t('full', { max: data.maxPending })}</Banner>
          ) : (
            <ProposeForm options={options} locales={locales} csrfToken={csrfToken} />
          )}
        </>
      ) : (
        <Banner tone="info">{t('not-enabled')}</Banner>
      )}
      <ProposalList
        proposals={data.proposals}
        labelOf={labelOf}
        locales={locales}
        csrfToken={csrfToken}
      />
      <ShelfList shelves={data.shelves} labelOf={labelOf} locales={locales} />
    </div>
  );
}

function ProposeForm({
  options,
  locales,
  csrfToken,
}: {
  readonly options: readonly { readonly value: string; readonly label: string }[];
  readonly locales: CategoryLocales;
  readonly csrfToken: string;
}) {
  const t = useTranslations('categories.proposals');
  const choices = orderedLocales(locales);
  const [parent, setParent] = useState('');
  const [locale, setLocale] = useState(locales.default);
  const [texts, setTexts] = useState<Record<string, FilledText>>({});
  const [pending, setPending] = useState(false);
  const [problem, setProblem] = useState<ProposeProblem | null>(null);
  const busy = useRef(false);
  const current = texts[locale] ?? { name: '', shortDescription: '' };
  const defaultName = (texts[locales.default]?.name ?? '').trim();
  const canSend = parent !== '' && defaultName !== '';
  const rtl = isRtl(locale);

  function change(patch: Partial<FilledText>) {
    setTexts({ ...texts, [locale]: { ...current, ...patch } });
  }
  const fieldError = (field: 'name' | 'shortDescription'): string | undefined => {
    const hit = problem?.fields.find((entry) => entry.locale === locale && entry.field === field);
    return hit === undefined ? undefined : t(`error.field.${hit.kind}`);
  };

  async function send() {
    if (busy.current || !canSend) return;
    busy.current = true;
    setPending(true);
    setProblem(null);
    const result = await callApi(
      'POST',
      'catalog/seller/category-proposals',
      { platformParentId: parent, texts: textsBody(texts) },
      csrfToken,
    );
    if (result.ok) {
      reload('?sent=1');
      return;
    }
    busy.current = false;
    setPending(false);
    if (result.failure.status === 401) {
      window.location.assign('/session-ended');
      return;
    }
    const next = proposalProblemOf(result.failure);
    setProblem(next);
    // Show the first locale with a problem, so the field error is in view.
    const first = next.fields[0];
    if (first !== undefined && first.locale !== locale && choices.includes(first.locale)) {
      setLocale(first.locale);
    }
  }

  return (
    <Card title={t('form.title')}>
      <form
        className="flex max-w-(--mp-size-form-max) flex-col gap-4"
        noValidate
        onSubmit={(event) => {
          event.preventDefault();
          void send();
        }}
      >
        {problem === null ? null : (
          <Banner tone="critical">
            <p>{t(`error.${problem.form}`, { max: problem.max ?? 0 })}</p>
            {problem.fields.length > 0 ? (
              <ul className="mt-1 list-disc ps-5">
                {problem.fields.map((entry) => (
                  <li key={`${entry.locale}.${entry.field}`}>
                    {t('error.in-field', {
                      language: localeName(entry.locale),
                      field: t(`form.field.${entry.field}`),
                      problem: t(`error.field.${entry.kind}`),
                    })}
                  </li>
                ))}
              </ul>
            ) : null}
          </Banner>
        )}
        <Select
          name="platformParentId"
          label={t('form.parent')}
          help={options.length === 0 ? t('form.parent-none') : t('form.parent-help')}
          placeholder={t('form.parent-placeholder')}
          options={options}
          value={parent}
          onChange={(event) => setParent(event.target.value)}
          required
        />
        <Select
          name="language"
          label={t('form.language')}
          help={t('form.language-help', { language: localeName(locales.default) })}
          options={choices.map((code) => ({
            value: code,
            label:
              code === locales.default
                ? t('form.language-required', { language: localeName(code) })
                : localeName(code),
          }))}
          value={locale}
          onChange={(event) => setLocale(event.target.value)}
        />
        <TextField
          key={`name.${locale}`}
          name={`name.${locale}`}
          label={t('form.name')}
          {...(locale === locales.default ? {} : { optionalLabel: t('form.optional') })}
          value={current.name}
          maxLength={NAME_MAX}
          autoComplete="off"
          lang={locale}
          dir={rtl ? 'rtl' : 'ltr'}
          error={fieldError('name')}
          onChange={(event) => change({ name: event.target.value })}
        />
        <TextAreaField
          key={`description.${locale}`}
          name={`description.${locale}`}
          label={t('form.description')}
          optionalLabel={t('form.optional')}
          rows={3}
          value={current.shortDescription}
          maxLength={DESCRIPTION_MAX}
          lang={locale}
          dir={rtl ? 'rtl' : 'ltr'}
          error={fieldError('shortDescription')}
          onChange={(event) => change({ shortDescription: event.target.value })}
        />
        <div>
          <Button type="submit" loading={pending} disabled={pending || !canSend}>
            {t('form.send')}
          </Button>
        </div>
      </form>
    </Card>
  );
}

function ProposalList({
  proposals,
  labelOf,
  locales,
  csrfToken,
}: {
  readonly proposals: readonly OwnProposal[];
  readonly labelOf: ReadonlyMap<string, string>;
  readonly locales: CategoryLocales;
  readonly csrfToken: string;
}) {
  const t = useTranslations('categories.proposals');
  const [error, setError] = useState<string | null>(null);
  const [cancelling, setCancelling] = useState<string | null>(null);

  async function cancel(proposal: OwnProposal) {
    if (cancelling !== null) return;
    setCancelling(proposal.id);
    setError(null);
    const result = await callApi(
      'POST',
      `catalog/seller/category-proposals/${proposal.id}/cancel`,
      { version: proposal.version },
      csrfToken,
    );
    if (result.ok) {
      reload();
      return;
    }
    setCancelling(null);
    if (result.failure.status === 401) {
      window.location.assign('/session-ended');
      return;
    }
    setError(proposalProblemOf(result.failure).form);
  }

  return (
    <section aria-labelledby="proposals-heading" className="flex flex-col gap-3">
      <h2 id="proposals-heading" className="text-lg font-semibold">
        {t('list.title')}
      </h2>
      {error === null ? null : <Banner tone="critical">{t(`error.${error}`, { max: 0 })}</Banner>}
      {proposals.length === 0 ? (
        <EmptyState
          size="compact"
          icon="inbox"
          title={t('list.empty.title')}
          body={t('list.empty.body')}
        />
      ) : (
        <ul className="flex flex-col gap-3">
          {proposals.map((proposal) => {
            const status = STATUSES.includes(proposal.status) ? proposal.status : 'cancelled';
            const reason =
              proposal.reasonCode === null
                ? null
                : t(
                    `list.reason.${REASONS.includes(proposal.reasonCode) ? proposal.reasonCode : 'other'}`,
                  );
            return (
              <li key={proposal.id} className="rounded-lg border border-line bg-surface p-4">
                <div className="flex flex-wrap items-start justify-between gap-3">
                  <div className="min-w-0">
                    <p className="break-words font-medium">
                      {nameOf(proposal.texts, locales.default) ?? t('list.unnamed')}
                    </p>
                    <p className="break-words text-sm text-fg-muted">
                      {t('list.under', {
                        parent: labelOf.get(proposal.platformParentId) ?? t('list.parent-unknown'),
                      })}
                    </p>
                  </div>
                  <Badge tone={STATUS_TONE[status] ?? 'neutral'}>
                    {t(`list.status.${status}`)}
                  </Badge>
                </div>
                {reason === null ? null : <p className="mt-2 text-sm">{reason}</p>}
                {proposal.status === 'pending' ? (
                  <div className="mt-3">
                    <Button
                      variant="secondary"
                      loading={cancelling === proposal.id}
                      disabled={cancelling !== null}
                      onClick={() => void cancel(proposal)}
                    >
                      {t('list.cancel')}
                    </Button>
                  </div>
                ) : null}
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}

function ShelfList({
  shelves,
  labelOf,
  locales,
}: {
  readonly shelves: readonly OwnShelf[];
  readonly labelOf: ReadonlyMap<string, string>;
  readonly locales: CategoryLocales;
}) {
  const t = useTranslations('categories.proposals');
  return (
    <section aria-labelledby="shelves-heading" className="flex flex-col gap-3">
      <h2 id="shelves-heading" className="text-lg font-semibold">
        {t('shelves.title')}
      </h2>
      <p className="max-w-(--mp-size-form-max) text-sm text-fg-muted">{t('shelves.note')}</p>
      {shelves.length === 0 ? (
        <EmptyState
          size="compact"
          icon="tag"
          title={t('shelves.empty.title')}
          body={t('shelves.empty.body')}
        />
      ) : (
        <ul className="flex flex-col gap-3">
          {shelves.map((shelf) => (
            <li
              key={shelf.id}
              className="flex flex-wrap items-start justify-between gap-3 rounded-lg border border-line bg-surface p-4"
            >
              <div className="min-w-0">
                <p className="break-words font-medium">
                  {nameOf(shelf.texts, locales.default) ?? shelf.slug}
                </p>
                <p className="break-words text-sm text-fg-muted">
                  {t('list.under', {
                    parent: labelOf.get(shelf.platformParentId) ?? t('list.parent-unknown'),
                  })}
                </p>
              </div>
              <Badge tone={shelf.status === 'active' ? 'success' : 'neutral'}>
                {t(`shelves.status.${shelf.status}`)}
              </Badge>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
