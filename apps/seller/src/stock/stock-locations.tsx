'use client';

import { Badge, Banner, Button } from '@mondapac/ui';
import { useTranslations } from 'next-intl';
import { useRef, useState } from 'react';
import { callApi } from '../api/client.ts';
import { problemOf, type StockProblem } from './errors.ts';
import { StockForm, type SourceInput } from './stock-form.tsx';
import type { SourceView, SourcesView, StockFormOptions } from './types.ts';

type Mode = { readonly kind: 'add' } | { readonly kind: 'edit'; readonly id: string } | null;

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
  const [saved, setSaved] = useState(false);
  const busy = useRef(false);

  /** One write at a time; the answer is the new list, which replaces the screen's copy. */
  async function write(method: 'POST' | 'PUT', path: string, body: unknown): Promise<boolean> {
    if (busy.current) return false;
    busy.current = true;
    setPending(true);
    setProblem(null);
    setSaved(false);
    const result = await callApi<SourcesView>(method, path, body, csrfToken);
    busy.current = false;
    setPending(false);
    if (result.ok) {
      setView(result.body);
      setSaved(true);
      return true;
    }
    if (result.failure.status === 401) window.location.assign('/session-ended');
    else setProblem(problemOf(result.failure));
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
    setSaved(false);
    setMode(next);
  }

  const editing =
    mode?.kind === 'edit' ? (view.sources.find((source) => source.id === mode.id) ?? null) : null;
  const full = view.sources.length >= view.max;

  return (
    <div className="flex max-w-(--mp-size-form-max) flex-col gap-4">
      <p className="text-fg-muted">{t('stock.intro', { max: view.max })}</p>
      {saved ? <Banner tone="success">{t('stock.saved')}</Banner> : null}
      {mode === null && problem !== null ? (
        <Banner tone="critical">
          {t(problem.form.key, problem.form.values)}
          {problem.form.key === 'stock.error.stale' ? (
            <>
              {' '}
              <Button variant="link" onClick={() => window.location.reload()}>
                {t('stock.reload')}
              </Button>
            </>
          ) : null}
        </Banner>
      ) : null}
      <ul className="flex flex-col gap-3">
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
      {mode !== null && (mode.kind === 'add' || editing !== null) ? (
        <StockForm
          key={mode.kind === 'edit' ? mode.id : 'new'}
          source={editing}
          options={options}
          pending={pending}
          problem={problem}
          onSubmit={(input) => void submit(input)}
          onCancel={() => open(null)}
        />
      ) : null}
      {canEdit && mode === null ? (
        <div>
          <Button onClick={() => open({ kind: 'add' })} disabled={full}>
            {t('stock.add')}
          </Button>
          {full ? (
            <p className="mt-2 text-sm text-fg-muted">{t('stock.full', { max: view.max })}</p>
          ) : null}
        </div>
      ) : null}
    </div>
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
  const address = source.address === null ? null : Object.values(source.address).join(', ');
  return (
    <li className="rounded-lg border border-line bg-surface p-4">
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-sm text-fg-muted">{index + 1}.</span>
        <h2 className="text-base font-semibold">{source.name}</h2>
        {source.isDefault ? <Badge tone="info">{t('stock.default')}</Badge> : null}
      </div>
      <dl className="mt-2 grid gap-1 text-sm">
        <div className="flex gap-2">
          <dt className="text-fg-muted">{t('stock.form.address')}</dt>
          <dd>{address ?? t('stock.no-address')}</dd>
        </div>
        <div className="flex gap-2">
          <dt className="text-fg-muted">{t('stock.form.zone')}</dt>
          <dd>{source.timeZone ?? t('stock.zone-own')}</dd>
        </div>
      </dl>
      {canEdit ? (
        <div className="mt-3 flex flex-wrap gap-2">
          <Button variant="secondary" onClick={onEdit} disabled={busy}>
            {t('stock.edit')}
          </Button>
          <Button
            variant="secondary"
            onClick={() => onMove(-1)}
            disabled={busy || index === 0}
            aria-label={t('stock.move-up', { name: source.name })}
          >
            {t('stock.up')}
          </Button>
          <Button
            variant="secondary"
            onClick={() => onMove(1)}
            disabled={busy || last}
            aria-label={t('stock.move-down', { name: source.name })}
          >
            {t('stock.down')}
          </Button>
        </div>
      ) : null}
    </li>
  );
}
