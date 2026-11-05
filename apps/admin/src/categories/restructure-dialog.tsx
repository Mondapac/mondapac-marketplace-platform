'use client';

import { Banner, Button, Dialog, SkeletonRows, TextAreaField, TextField } from '@mondapac/ui';
import { useTranslations } from 'next-intl';
import { useEffect, useId, useMemo, useRef, useState } from 'react';
import { callApi } from '../api/client.ts';
import { CategoryProblemBanner } from './category-problem.tsx';
import {
  TOP,
  checkReason,
  filterTargets,
  reasonOf,
  targetRows,
  type RestructureKind,
} from './restructure-model.ts';
import { directionOf, nameOf } from './tree-model.ts';
import { useCategoryCall } from './use-category-call.ts';
import {
  API_CATEGORIES,
  type CategoryRow,
  type DetailBody,
  type ImpactBody,
  type WriteWrap,
} from './types.ts';

type ImpactState =
  | { readonly kind: 'loading' }
  | { readonly kind: 'failed' }
  | { readonly kind: 'ready'; readonly body: ImpactBody };

/** What the change reaches; read again whenever the target changes (the last answer wins). */
function useImpact(categoryId: string, action: RestructureKind, target: string | null) {
  const [state, setState] = useState<ImpactState>({ kind: 'loading' });
  const latest = useRef(0);
  useEffect(() => {
    const ticket = ++latest.current;
    setState({ kind: 'loading' });
    const query = new URLSearchParams({ action });
    if (target !== null) query.set('targetId', target);
    void callApi<ImpactBody>(
      'GET',
      `${API_CATEGORIES}/${categoryId}/impact?${query.toString()}`,
    ).then((result) => {
      if (ticket !== latest.current) return;
      if (result.ok) setState({ kind: 'ready', body: result.body });
      else if (result.failure.status === 401) window.location.assign('/session-ended');
      else setState({ kind: 'failed' });
    });
  }, [categoryId, action, target]);
  return state;
}

function WhatWillChange({ state }: { readonly state: ImpactState }) {
  const t = useTranslations('categories.restructure');
  if (state.kind === 'loading') return <SkeletonRows label={t('impact-loading')} rows={2} />;
  if (state.kind === 'failed') return <Banner tone="attention">{t('impact-error')}</Banner>;
  const { body } = state;
  // "at least N" when the API stopped counting at its time bound; never "at least 0".
  const worded = (text: string, n: number) =>
    body.complete || n === 0 ? text : t('at-least', { text });
  const parts = [
    worded(t('products', { n: body.products }), body.products),
    worded(t('offers', { n: body.offers }), body.offers),
    worded(t('tagged', { n: body.offersWithActiveTag }), body.offersWithActiveTag),
    worded(t('subcategories', { n: body.descendants }), body.descendants),
  ];
  return (
    <div className="flex flex-col gap-1" data-testid="restructure-impact">
      <p className="m-0">{parts.join(', ')}</p>
      {body.featureSetChanges === undefined ? null : (
        <p className="m-0">
          {worded(t('feature-sets', { n: body.featureSetChanges }), body.featureSetChanges)}
        </p>
      )}
    </div>
  );
}

/** The target as a list of radio choices in tree order, indented by level. No drag. */
function TargetPicker({
  legend,
  rows,
  locale,
  value,
  withTop,
  disabled,
  onChange,
}: {
  readonly legend: string;
  readonly rows: readonly CategoryRow[];
  readonly locale: string;
  readonly value: string | null;
  readonly withTop: boolean;
  readonly disabled: boolean;
  readonly onChange: (value: string) => void;
}) {
  const t = useTranslations('categories.restructure');
  const group = useId();
  const [typed, setTyped] = useState('');
  const shown = useMemo(() => filterTargets(rows, typed, locale), [rows, typed, locale]);
  const choices: {
    id: string;
    label: string;
    depth: number;
    dir: 'ltr' | 'rtl' | 'auto';
    hidden: boolean;
  }[] = shown.map((row) => ({
    id: row.id,
    label: nameOf(row, locale),
    depth: row.depth,
    dir: row.names.some((entry) => entry.locale === locale) ? directionOf(locale) : 'auto',
    hidden: row.status === 'hidden',
  }));
  const showTop = withTop && typed.trim() === '';
  return (
    <fieldset className="m-0 flex min-w-0 flex-col gap-2 border-0 p-0">
      <legend className="mb-1 text-sm font-medium text-fg">{legend}</legend>
      <TextField
        name="target-search"
        type="search"
        label={t('search')}
        value={typed}
        autoComplete="off"
        onChange={(event) => setTyped(event.target.value)}
      />
      <div className="max-h-64 overflow-y-auto rounded-md border border-line">
        {showTop ? (
          <label className="flex min-h-11 cursor-pointer items-center gap-3 border-b border-line px-3">
            <input
              type="radio"
              name={group}
              value={TOP}
              checked={value === TOP}
              disabled={disabled}
              className="size-5 shrink-0 accent-accent"
              onChange={() => onChange(TOP)}
            />
            <span>{t('top')}</span>
          </label>
        ) : null}
        {choices.map((choice) => (
          <label
            key={choice.id}
            className="flex min-h-11 cursor-pointer items-center gap-3 border-b border-line py-1 pe-3 last:border-b-0"
            style={{ paddingInlineStart: `${choice.depth * 1.25 + 0.75}rem` }}
          >
            <input
              type="radio"
              name={group}
              value={choice.id}
              checked={value === choice.id}
              disabled={disabled}
              className="size-5 shrink-0 accent-accent"
              onChange={() => onChange(choice.id)}
            />
            <span dir={choice.dir} className="min-w-0 break-words">
              {choice.label}
            </span>
            {choice.hidden ? (
              <span className="shrink-0 text-sm text-fg-muted">{t('status-hidden')}</span>
            ) : null}
          </label>
        ))}
        {choices.length === 0 && !showTop ? (
          <p className="m-0 px-3 py-3 text-fg-muted">{t('no-match')}</p>
        ) : null}
      </div>
    </fieldset>
  );
}

/**
 * Move, Merge or Archive: pick the target (move and merge), see what will change, give a reason of
 * 10 to 500 characters, then one write. The tree version is the one the details were read with.
 */
export function RestructureDialog({
  kind,
  body,
  name,
  rows,
  locale,
  csrfToken,
  onClose,
  onDone,
  onReload,
}: {
  readonly kind: RestructureKind;
  readonly body: DetailBody;
  readonly name: string;
  /** Every category of the tree, in tree order. */
  readonly rows: readonly CategoryRow[];
  /** The language the names are shown in. */
  readonly locale: string;
  readonly csrfToken: string;
  readonly onClose: () => void;
  /** The write went through; the owner closes the dialog and reads the tree again. */
  readonly onDone: () => void;
  readonly onReload: () => void;
}) {
  const t = useTranslations('categories.restructure');
  const call = useCategoryCall(csrfToken, true);
  const [target, setTarget] = useState<string | null>(null);
  const [reason, setReason] = useState('');
  const [touched, setTouched] = useState(false);
  const candidates = useMemo(() => targetRows(rows, body.category.id), [rows, body.category.id]);
  const picks = kind !== 'archive';
  const impact = useImpact(body.category.id, kind, picks ? target : null);
  const state = checkReason(reason);
  const ready = state === 'ok' && (!picks || target !== null);
  const note = !ready
    ? picks && target === null
      ? t('need-target')
      : t('need-reason')
    : undefined;
  const noteId = useId();
  const cancel = useRef<HTMLButtonElement>(null);

  async function submit() {
    if (!ready) return;
    const reasonText = reasonOf(reason);
    const payload =
      kind === 'move'
        ? {
            treeVersion: body.treeVersion,
            parentId: target === TOP ? null : target,
            reason: reasonText,
          }
        : kind === 'merge'
          ? { treeVersion: body.treeVersion, targetId: target, reason: reasonText }
          : { treeVersion: body.treeVersion, reason: reasonText };
    const answer = await call.run<WriteWrap>(
      'POST',
      `${API_CATEGORIES}/${body.category.id}/${kind}`,
      payload,
    );
    if (answer.ok) onDone();
  }

  const problem = call.problem;
  const reasonError =
    state === 'long'
      ? t('reason-long')
      : touched && state === 'short'
        ? t('reason-short')
        : undefined;
  return (
    <Dialog
      open
      title={t(`title.${kind}`, { name })}
      onClose={onClose}
      {...(kind === 'archive' ? { initialFocus: cancel } : {})}
      {...(note === undefined ? {} : { actionsNote: <span id={noteId}>{note}</span> })}
      actions={
        <>
          <Button ref={cancel} variant="secondary" disabled={call.pending} onClick={onClose}>
            {t('cancel')}
          </Button>
          {problem?.reload === true ? (
            <Button onClick={onReload}>{t('reload')}</Button>
          ) : (
            <Button
              variant={kind === 'archive' ? 'destructive-solid' : 'primary'}
              loading={call.pending}
              disabled={!ready || call.pending}
              aria-describedby={note === undefined ? undefined : noteId}
              onClick={() => void submit()}
            >
              {t(`action.${kind}`)}
            </Button>
          )}
        </>
      }
    >
      <div className="flex flex-col gap-4">
        <CategoryProblemBanner problem={problem} />
        <p className="m-0">{t(`intro.${kind}`, { name })}</p>
        {kind === 'archive' ? <Banner tone="attention">{t('terminal')}</Banner> : null}
        {picks ? (
          <TargetPicker
            legend={t(kind === 'move' ? 'target-move' : 'target-merge')}
            rows={candidates}
            locale={locale}
            value={target}
            withTop={kind === 'move'}
            disabled={call.pending}
            onChange={setTarget}
          />
        ) : null}
        <section aria-labelledby={`${noteId}-impact`} className="flex flex-col gap-2">
          <h3 id={`${noteId}-impact`} className="m-0 text-base font-semibold">
            {t('impact-title')}
          </h3>
          <WhatWillChange state={impact} />
        </section>
        <TextAreaField
          label={t('reason')}
          help={t('reason-help')}
          counter={t('reason-counter', { n: reasonOf(reason).length })}
          error={reasonError}
          rows={4}
          value={reason}
          required
          autoComplete="off"
          onChange={(event) => setReason(event.target.value)}
          onBlur={() => setTouched(true)}
        />
      </div>
    </Dialog>
  );
}
