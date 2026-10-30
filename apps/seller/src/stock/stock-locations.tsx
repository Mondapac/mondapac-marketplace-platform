'use client';

import {
  addressLines,
  Badge,
  Banner,
  Button,
  DataList,
  SettingsPage,
  SettingsSection,
  toast,
} from '@mondapac/ui';
import { useTranslations } from 'next-intl';
import { useRef, useState } from 'react';
import { callApi } from '../api/client.ts';
import { problemOf, type StockProblem } from './errors.ts';
import { StockForm, type SourceInput } from './stock-form.tsx';
import type { SourceView, SourcesView, StockFormOptions } from './types.ts';

type Mode = { readonly kind: 'add' } | { readonly kind: 'edit'; readonly id: string } | null;

/**
 * The seller's stock locations: a list with its own actions (add, edit, move), not a form with
 * one save. The add and edit form is an editor of one entry and keeps its own Save and Cancel.
 */
export function StockLocations({
  initial,
  options,
  csrfToken,
  canEdit,
}: {
  readonly initial: SourcesView;
  readonly options: StockFormOptions;
  readonly csrfToken: string;
  readonly canEdit: boolean;
}) {
  const t = useTranslations();
  const [view, setView] = useState(initial);
  const [mode, setMode] = useState<Mode>(null);
  const [pending, setPending] = useState(false);
  const [problem, setProblem] = useState<StockProblem | null>(null);
  const [failedWrites, setFailedWrites] = useState(0);
  // Counts the conflicts of this page; the open editor lists what differs from the saved location.
  const [conflictId, setConflictId] = useState<number | null>(null);
  const busy = useRef(false);

  /** One write at a time; the answer is the new list, which replaces the screen's copy. */
  async function write(method: 'POST' | 'PUT', path: string, body: unknown): Promise<boolean> {
    if (busy.current) return false;
    busy.current = true;
    setPending(true);
    setProblem(null);
    setConflictId(null);
    const result = await callApi<SourcesView>(method, path, body, csrfToken);
    if (result.ok) {
      busy.current = false;
      setPending(false);
      setView(result.body);
      toast.success(t('stock.saved'));
      return true;
    }
    if (result.failure.status === 401) window.location.assign('/session-ended');
    else if (result.failure.code === 'conflict.stale') {
      // Someone saved first: take the list as it is saved now (so the next write carries its
      // version) and keep the editor's draft; the editor shows the saved location next to it.
      const fresh = await callApi<SourcesView>('GET', 'inventory/seller/sources');
      if (fresh.ok) {
        setView(fresh.body);
        setConflictId((n) => (n ?? 0) + 1);
      } else {
        setProblem(problemOf(result.failure));
      }
    } else {
      setProblem(problemOf(result.failure));
      setFailedWrites((n) => n + 1);
    }
    busy.current = false;
    setPending(false);
    return false;
  }

  async function submit(input: SourceInput) {
    const body = { expectedVersion: view.version, ...input };
    const done =
      mode?.kind === 'edit'
        ? await write('PUT', `inventory/seller/sources/${mode.id}`, body)
        : await write('POST', 'inventory/seller/sources', body);
    if (done) setMode(null);
  }

  async function move(index: number, by: -1 | 1) {
    const ids = view.sources.map((source) => source.id);
    const target = index + by;
    if (target < 0 || target >= ids.length) return;
    [ids[index], ids[target]] = [ids[target] as string, ids[index] as string];
    await write('PUT', 'inventory/seller/sources-order', {
      expectedVersion: view.version,
      orderedSourceIds: ids,
    });
  }

  function open(next: Mode) {
    setProblem(null);
    setConflictId(null);
    setMode(next);
  }

  const editing =
    mode?.kind === 'edit' ? (view.sources.find((source) => source.id === mode.id) ?? null) : null;
  const full = view.sources.length >= view.max;

  const banners = [
    canEdit ? null : (
      <Banner key="view-only" tone="info">
        {t('stock.view-only')}
      </Banner>
    ),
    // A conflict while no editor is open (a move): the list is already up to date.
    mode === null && conflictId !== null ? (
      <Banner key="list-changed" tone="attention">
        {t('stock.error.list-changed')}
      </Banner>
    ) : null,
    mode === null && problem !== null ? (
      <Banner key="problem" tone="critical">
        {t(problem.form.key, problem.form.values)}
      </Banner>
    ) : null,
  ].filter((node) => node !== null);

  return (
    <SettingsPage
      title={t('stock.title')}
      description={t('stock.intro', { max: view.max })}
      actions={
        canEdit && mode === null ? (
          <div className="flex flex-col gap-2 sm:items-end">
            <Button onClick={() => open({ kind: 'add' })} disabled={full}>
              {t('stock.add')}
            </Button>
            {full ? (
              <p className="text-sm text-fg-muted">{t('stock.full', { max: view.max })}</p>
            ) : null}
          </div>
        ) : null
      }
      banner={
        banners.length === 0 ? undefined : <div className="flex flex-col gap-3">{banners}</div>
      }
    >
      <SettingsSection title={t('stock.section')}>
        <ul className="flex flex-col">
          {view.sources.map((source, index) => (
            <SourceRow
              key={source.id}
              source={source}
              index={index}
              last={index === view.sources.length - 1}
              canEdit={canEdit}
              busy={pending}
              onEdit={() => open({ kind: 'edit', id: source.id })}
              onMove={(by) => void move(index, by)}
            />
          ))}
        </ul>
      </SettingsSection>
      {mode !== null && (mode.kind === 'add' || editing !== null) ? (
        <StockForm
          key={mode.kind === 'edit' ? mode.id : 'new'}
          source={editing}
          options={options}
          pending={pending}
          problem={problem}
          failedWrites={failedWrites}
          conflictId={conflictId}
          onSubmit={(input) => void submit(input)}
          onCancel={() => open(null)}
        />
      ) : null}
    </SettingsPage>
  );
}

function SourceRow({
  source,
  index,
  last,
  canEdit,
  busy,
  onEdit,
  onMove,
}: {
  readonly source: SourceView;
  readonly index: number;
  readonly last: boolean;
  readonly canEdit: boolean;
  readonly busy: boolean;
  readonly onEdit: () => void;
  readonly onMove: (by: -1 | 1) => void;
}) {
  const t = useTranslations();
  return (
    <li className="border-b border-line-row px-5 py-4 last:border-b-0">
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-sm text-fg-muted">{index + 1}.</span>
        <h3 className="text-base font-semibold">{source.name}</h3>
        {source.isDefault ? <Badge tone="info">{t('stock.default')}</Badge> : null}
      </div>
      <div className="mt-3 text-sm">
        <DataList
          missing={t('stock.no-address')}
          rows={[
            { label: t('stock.form.address'), value: addressLines(source.address) },
            { label: t('stock.form.zone'), value: source.timeZone ?? t('stock.zone-own') },
          ]}
        />
      </div>
      {canEdit ? (
        <div className="mt-3 flex flex-wrap gap-2">
          <Button variant="secondary" onClick={onEdit} disabled={busy}>
            {t('stock.edit')}
          </Button>
          {/* Moving only shows where it can move: not up from the first, not down from the last. */}
          {index > 0 ? (
            <Button
              variant="secondary"
              onClick={() => onMove(-1)}
              disabled={busy}
              aria-label={t('stock.move-up', { name: source.name })}
            >
              {t('stock.up')}
            </Button>
          ) : null}
          {last ? null : (
            <Button
              variant="secondary"
              onClick={() => onMove(1)}
              disabled={busy}
              aria-label={t('stock.move-down', { name: source.name })}
            >
              {t('stock.down')}
            </Button>
          )}
        </div>
      ) : null}
    </li>
  );
}
