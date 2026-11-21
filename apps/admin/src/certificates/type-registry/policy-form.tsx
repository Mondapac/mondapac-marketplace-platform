'use client';

import {
  Banner,
  Button,
  Dialog,
  SaveBar,
  Select,
  TextAreaField,
  useUnsavedChangesGuard,
} from '@mondapac/ui';
import { useTranslations } from 'next-intl';
import { useRef, useState, type FormEvent } from 'react';
import { flushSync } from 'react-dom';
import { REVIEW_NOTE_MAX, ReviewNoteField, trimmedNote } from '../../shared/review-note.tsx';
import {
  API_POLICIES,
  POLICY_BASES,
  POLICY_HANDLINGS,
  REASON_MAX,
  type PolicyRow,
  type PolicySaved,
} from './types.ts';
import { useTypeCall } from './use-type-call.ts';

/** The most rows the API takes in one policy (`MAX_POLICY_ROWS` in the certification domain). */
const MAX_ROWS = 304;

interface RowDraft {
  readonly id: number;
  readonly selector: 'platform-category' | 'handling';
  readonly categoryId: string;
  readonly handling: string;
  readonly basis: string;
}

export interface CategoryChoice {
  readonly id: string;
  readonly name: string;
  readonly depth: number;
}

/** What identifies a row in a policy: one row per category and per handling type. */
const keyOf = (row: Pick<RowDraft, 'selector' | 'categoryId' | 'handling'>): string =>
  row.selector === 'platform-category' ? `row:${row.categoryId}` : `row:${row.handling}`;

function draftOf(rows: readonly PolicyRow[]): RowDraft[] {
  return rows.map((row, index) => ({
    id: index,
    selector: row.selector,
    categoryId: row.categoryId ?? '',
    handling: row.handling ?? POLICY_HANDLINGS[0],
    basis: row.basis,
  }));
}

/** The rows as the API takes them. */
function rowsOf(drafts: readonly RowDraft[]): PolicyRow[] {
  return drafts.map((row) =>
    row.selector === 'platform-category'
      ? { selector: row.selector, categoryId: row.categoryId, basis: row.basis }
      : { selector: row.selector, handling: row.handling, basis: row.basis },
  );
}

/** What differs from the published rows: the row, what it was and what it becomes. */
function changesOf(
  published: readonly PolicyRow[],
  drafts: readonly RowDraft[],
): { readonly path: string; readonly before: string | null; readonly after: string | null }[] {
  const before = new Map<string, string>();
  for (const row of published)
    before.set(
      keyOf({
        selector: row.selector,
        categoryId: row.categoryId ?? '',
        handling: row.handling ?? '',
      }),
      row.basis,
    );
  const after = new Map<string, string>();
  for (const row of drafts) after.set(keyOf(row), row.basis);
  const out: { path: string; before: string | null; after: string | null }[] = [];
  for (const path of new Set([...before.keys(), ...after.keys()])) {
    const was = before.get(path) ?? null;
    const now = after.get(path) ?? null;
    if (was !== now) out.push({ path, before: was, after: now });
  }
  return out;
}

/** Per-row problems, as keys under `certificates.types.policy.problem`, by row id. */
function problemsOf(drafts: readonly RowDraft[]): Map<number, string> {
  const out = new Map<number, string>();
  const seen = new Set<string>();
  for (const row of drafts) {
    if (row.selector === 'platform-category' && row.categoryId === '') {
      out.set(row.id, 'category');
      continue;
    }
    if (row.selector === 'handling' && row.basis === 'SELLER_OR_MANUFACTURER') {
      out.set(row.id, 'manufacturer');
      continue;
    }
    const key = keyOf(row);
    if (seen.has(key)) out.set(row.id, 'duplicate');
    seen.add(key);
  }
  return out;
}

/**
 * The rows of a claim basis policy (certificates design CA8): which basis a claim needs for a
 * platform category or a handling type. Saving asks first and lists what changes; whether it is
 * published or waits for a second admin, and whether it opens a review, is the API's answer.
 */
export function PolicyForm({
  typeId,
  version,
  published,
  categories,
  reviewed,
  csrfToken,
}: {
  readonly typeId: string;
  readonly version: number;
  readonly published: readonly PolicyRow[];
  readonly categories: readonly CategoryChoice[];
  /** The Market reviews saves in System requests: a note for the reviewer is needed. */
  readonly reviewed: boolean;
  readonly csrfToken: string;
}) {
  const t = useTranslations('certificates.types.policy');
  const tb = useTranslations('certificates.types.basis');
  const tr = useTranslations();
  const call = useTypeCall(csrfToken);
  const next = useRef(published.length);
  const cancel = useRef<HTMLButtonElement>(null);
  const [rows, setRows] = useState<RowDraft[]>(() => draftOf(published));
  const [reason, setReason] = useState('');
  const [note, setNote] = useState('');
  const [shown, setShown] = useState(false);
  const [confirming, setConfirming] = useState(false);
  // Set once the policy is saved and the browser is sent on: the leave prompt stays quiet.
  const [leaving, setLeaving] = useState(false);

  const names = new Map(categories.map((category) => [`row:${category.id}`, category.name]));
  const nameOf = (path: string) =>
    path.startsWith('row:') && (POLICY_HANDLINGS as readonly string[]).includes(path.slice(4))
      ? t(`handling.${path.slice(4)}` as never)
      : (names.get(path) ?? path.slice(4));
  const basis = (value: string | null) =>
    value === null ? t('no-row') : tb.has(value as never) ? tb(value as never) : value;
  const known = new Set(categories.map((category) => category.id));
  const categoryOptions = [
    ...categories.map((category) => ({
      value: category.id,
      label: `${'– '.repeat(category.depth)}${category.name}`,
    })),
    // A published row of a category the tree no longer lists keeps its place, shown by its id.
    ...rows
      .filter((row) => row.selector === 'platform-category' && row.categoryId !== '')
      .filter((row) => !known.has(row.categoryId))
      .map((row) => ({ value: row.categoryId, label: row.categoryId })),
  ];

  const problems = problemsOf(rows);
  const changes = changesOf(published, rows);
  const reasonTooLong = reason.trim().length > REASON_MAX;
  const sentNote = trimmedNote(note);
  const noteMissing = reviewed && sentNote === null;
  const failed = problems.size > 0 || reasonTooLong || noteMissing;
  // A second row for the same category changes nothing by itself, but it is still unsaved work
  // (and a problem to fix), so the bar counts it.
  const count = Math.max(changes.length, rows.length !== published.length ? 1 : 0);
  const errorCount = shown ? problems.size + Number(reasonTooLong) + Number(noteMissing) : 0;
  // Leaving with rows that are not saved asks first (the dialog the settings pages use).
  const guard = useUnsavedChangesGuard(
    count > 0 && !leaving,
    {
      title: tr('settings.leave.title'),
      message: (info) => tr('settings.leave.message', { count: info.count, page: info.page }),
      stay: tr('settings.leave.stay'),
      leave: tr('settings.leave.leave'),
    },
    { count, page: t('title') },
  );

  function discard() {
    setRows(draftOf(published));
    setReason('');
    setNote('');
    setShown(false);
  }

  const patch = (id: number, change: Partial<RowDraft>) =>
    setRows((current) => current.map((row) => (row.id === id ? { ...row, ...change } : row)));

  function add(selector: RowDraft['selector']) {
    next.current += 1;
    setRows((current) => [
      ...current,
      {
        id: next.current,
        selector,
        categoryId: '',
        handling: POLICY_HANDLINGS[0],
        basis: POLICY_BASES[0],
      },
    ]);
  }

  function review(event: FormEvent) {
    event.preventDefault();
    setShown(true);
    if (failed || changes.length === 0) return;
    setConfirming(true);
  }

  async function save() {
    const why = reason.trim();
    const answer = await call.run<PolicySaved>(`${API_POLICIES}/${typeId}/revisions`, {
      version,
      rows: rowsOf(rows),
      ...(why === '' ? {} : { reason: why }),
      ...(reviewed && sentNote !== null ? { note: sentNote } : {}),
    });
    if (answer.ok) {
      const what = answer.body.outcome === 'published' ? 'published' : 'pending';
      const request = answer.body.request === null ? '' : `&sr=${answer.body.request.number}`;
      flushSync(() => setLeaving(true));
      window.location.assign(`/certificates/types/${typeId}/policy?done=${what}${request}`);
    }
  }

  return (
    <form onSubmit={review} className="flex flex-col gap-4" noValidate>
      <p className="text-fg-muted">{t('form.intro')}</p>
      {rows.length === 0 ? <p className="text-fg-muted">{t('form.no-rows')}</p> : null}
      <ul className="flex flex-col gap-3">
        {rows.map((row, index) => {
          const problem = shown ? problems.get(row.id) : undefined;
          return (
            <li key={row.id}>
              <fieldset className="flex flex-col gap-3 rounded-lg border border-line bg-surface p-4">
                <legend className="px-1 text-base font-semibold">
                  {t('form.row', { n: index + 1 })}
                </legend>
                <div className="grid gap-3 sm:grid-cols-2">
                  {row.selector === 'platform-category' ? (
                    <Select
                      label={t('form.category')}
                      placeholder={t('form.pick-category')}
                      value={row.categoryId}
                      options={categoryOptions}
                      onChange={(event) => patch(row.id, { categoryId: event.target.value })}
                      error={problem === 'category' ? t('problem.category') : undefined}
                    />
                  ) : (
                    <Select
                      label={t('form.handling')}
                      value={row.handling}
                      options={POLICY_HANDLINGS.map((value) => ({
                        value,
                        label: t(`handling.${value}`),
                      }))}
                      onChange={(event) => patch(row.id, { handling: event.target.value })}
                      error={problem === 'duplicate' ? t('problem.duplicate') : undefined}
                    />
                  )}
                  <Select
                    label={t('form.basis')}
                    value={row.basis}
                    options={POLICY_BASES.filter(
                      (value) =>
                        row.selector === 'platform-category' || value !== 'SELLER_OR_MANUFACTURER',
                    ).map((value) => ({ value, label: basis(value) }))}
                    onChange={(event) => patch(row.id, { basis: event.target.value })}
                    error={problem === 'manufacturer' ? t('problem.manufacturer') : undefined}
                  />
                </div>
                {problem === 'duplicate' && row.selector === 'platform-category' ? (
                  <p className="text-sm text-fg-critical" role="alert">
                    {t('problem.duplicate')}
                  </p>
                ) : null}
                <div>
                  <Button
                    type="button"
                    variant="secondary"
                    onClick={() => setRows((current) => current.filter((x) => x.id !== row.id))}
                  >
                    {t('form.remove')}
                  </Button>
                </div>
              </fieldset>
            </li>
          );
        })}
      </ul>
      <div className="flex flex-wrap gap-2">
        <Button
          type="button"
          variant="secondary"
          disabled={rows.length >= MAX_ROWS}
          onClick={() => add('platform-category')}
        >
          {t('form.add-category')}
        </Button>
        <Button
          type="button"
          variant="secondary"
          disabled={rows.length >= MAX_ROWS}
          onClick={() => add('handling')}
        >
          {t('form.add-handling')}
        </Button>
      </div>
      <TextAreaField
        label={t('form.reason')}
        optionalLabel={t('form.optional')}
        rows={3}
        value={reason}
        onChange={(event) => setReason(event.target.value)}
        help={t('form.reason-help', { max: REASON_MAX })}
        error={shown && reasonTooLong ? t('problem.reason', { max: REASON_MAX }) : undefined}
      />
      {reviewed ? (
        <ReviewNoteField
          value={note}
          onChange={(value) => setNote(value.slice(0, REVIEW_NOTE_MAX))}
          error={shown && noteMissing ? 'required' : undefined}
        />
      ) : null}
      <SaveBar
        count={count}
        summary={tr('settings.bar.summary', { count })}
        errorCount={errorCount}
        errorsSummary={tr('settings.bar.errors', { count: errorCount })}
        labels={{
          region: tr('settings.bar.region'),
          discard: tr('settings.bar.discard'),
          // Save opens the confirmation that lists the changes; nothing is sent yet.
          save: t('form.review'),
          saving: t('form.review'),
        }}
        onDiscard={discard}
      />
      {guard.dialog}
      {confirming ? (
        <Dialog
          open
          title={t('confirm.title')}
          onClose={() => {
            if (!call.pending) setConfirming(false);
          }}
          initialFocus={cancel}
          actions={
            <>
              <Button
                ref={cancel}
                variant="secondary"
                disabled={call.pending}
                onClick={() => setConfirming(false)}
              >
                {t('confirm.back')}
              </Button>
              {call.problem?.reload === true ? (
                <Button
                  type="button"
                  autoFocus
                  onClick={() => {
                    // The draft is stale: reloading is the way out, so the leave prompt stays quiet.
                    flushSync(() => setLeaving(true));
                    window.location.reload();
                  }}
                >
                  {t('confirm.reload')}
                </Button>
              ) : (
                <Button loading={call.pending} disabled={call.pending} onClick={() => void save()}>
                  {t('confirm.save')}
                </Button>
              )}
            </>
          }
        >
          <div className="flex flex-col gap-3">
            <div aria-live="polite" className="flex flex-col gap-2">
              {call.problem === null ? null : (
                <Banner tone="critical">{tr(call.problem.key)}</Banner>
              )}
              {call.problem === null || call.problem.issues.length === 0 ? null : (
                <ul className="list-disc ps-5 text-sm">
                  {call.problem.issues.map((key) => (
                    <li key={key}>{t(`issue.${key}` as never)}</li>
                  ))}
                </ul>
              )}
            </div>
            <p>{t('confirm.body')}</p>
            <ul className="flex flex-col gap-2">
              {changes.map((change) => (
                <li key={change.path} className="text-sm wrap-anywhere">
                  <span className="font-medium">{nameOf(change.path)}</span>
                  <br />
                  <span className="text-fg-muted">{t('confirm.from')}</span> {basis(change.before)}
                  <br />
                  <span className="text-fg-muted">{t('confirm.to')}</span> {basis(change.after)}
                </li>
              ))}
            </ul>
            <Banner tone="info">{t('confirm.second-admin')}</Banner>
          </div>
        </Dialog>
      ) : null}
    </form>
  );
}
