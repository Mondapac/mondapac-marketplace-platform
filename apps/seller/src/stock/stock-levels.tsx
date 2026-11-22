'use client';

import {
  Banner,
  Card,
  SaveBar,
  TextField,
  toast,
  useSectionSaves,
  useUnsavedChangesGuard,
  type SectionResult,
} from '@mondapac/ui';
import { useTranslations } from 'next-intl';
import { useRouter } from 'next/navigation';
import { useEffect, useRef, useState } from 'react';
import { flushSync } from 'react-dom';
import { callApi } from '../api/client.ts';
import { levelsProblemOf } from './levels-errors.ts';
import type { StockCell, StockLevelsView, StockSet } from './levels-types.ts';
import type { SourceView } from './types.ts';

const MAX_ON_HAND = 1_000_000;

/** A whole number from 0 up, or null. */
export function onHandOf(text: string): number | null {
  if (!/^\d{1,7}$/.test(text.trim())) return null;
  const value = Number(text);
  return value <= MAX_ON_HAND ? value : null;
}

/** What the screen knows of one level: the stored number and version, the typed text, its message. */
interface Draft {
  readonly onHand: number | null;
  readonly version: number | null;
  readonly text: string;
  /** The message name under the field (`stock.levels.error.*`), or none. */
  readonly problem: string | null;
  /** For a stale write: the version the screen held then, so the reloaded level can be named. */
  readonly staleAt: number | null;
}

const keyOf = (variantId: string, sourceId: string) => `${variantId}:${sourceId}`;

function draftsOf(view: StockLevelsView): Map<string, Draft> {
  const drafts = new Map<string, Draft>();
  for (const variant of view.variants) {
    for (const cell of variant.sources) {
      drafts.set(keyOf(variant.variantId, cell.sourceId), {
        onHand: cell.onHand,
        version: cell.version,
        text: String(cell.onHand),
        problem: null,
        staleAt: null,
      });
    }
  }
  return drafts;
}

const EMPTY: Draft = { onHand: null, version: null, text: '', problem: null, staleAt: null };
const isDirty = (draft: Draft) => draft.text.trim() !== String(draft.onHand ?? '');

function Cell({
  variantId,
  source,
  cell,
  draft,
  editable,
  onText,
}: {
  readonly variantId: string;
  readonly source: SourceView;
  readonly cell: StockCell | undefined;
  readonly draft: Draft;
  readonly editable: boolean;
  readonly onText: (text: string) => void;
}) {
  const t = useTranslations();
  const label = t('stock.levels.on-hand');
  const help = t('stock.levels.held', { count: cell?.held ?? 0 });
  const message =
    draft.problem === null
      ? undefined
      : draft.problem !== 'stale'
        ? t(`stock.levels.error.${draft.problem}`)
        : draft.version !== draft.staleAt
          ? t('stock.levels.error.stale-now', { onHand: draft.onHand ?? 0 })
          : t('stock.levels.error.stale-loading');
  if (!editable) {
    return (
      <p className="flex flex-col gap-1">
        <span>
          <span className="text-fg-muted">{label}: </span>
          <span className="font-medium">{cell === undefined ? '-' : cell.onHand}</span>
        </span>
        <span className="text-sm text-fg-muted">{help}</span>
      </p>
    );
  }
  return (
    <TextField
      name={`onHand-${variantId}-${source.id}`}
      label={label}
      // The visible label sits under the location's heading; the name read out carries it.
      aria-label={t('stock.levels.on-hand-for', { location: source.name })}
      inputMode="numeric"
      help={help}
      value={draft.text}
      error={message}
      onChange={(event) => onText(event.target.value)}
    />
  );
}

/**
 * Stock of one offer: a row per variant, a column per location, held units read only. Every
 * changed level is saved by the page's one save bar, one level after another (each is its own
 * versioned write); a refused level keeps its number and message while the others save.
 */
export function StockLevels({
  offerId,
  view,
  sources,
  canEdit,
  csrfToken,
}: {
  readonly offerId: string;
  readonly view: StockLevelsView;
  readonly sources: readonly SourceView[];
  readonly canEdit: boolean;
  readonly csrfToken: string;
}) {
  const t = useTranslations();
  const router = useRouter();
  const [drafts, setDrafts] = useState(() => draftsOf(view));
  const [leaving, setLeaving] = useState(false);
  const formRef = useRef<HTMLFormElement>(null);
  // Bumped after a refused run: focus moves once React has drawn the messages and unlocked the form.
  const [focusTick, setFocusTick] = useState(0);
  useEffect(() => {
    if (focusTick > 0) focusFirstInvalid(formRef.current);
  }, [focusTick]);
  // The latest drafts for a save running across several awaits.
  const latest = useRef(drafts);
  latest.current = drafts;

  // A refresh (after a stale write) brings the stored levels: adopt them, keep what was typed.
  useEffect(() => {
    const stored = draftsOf(view);
    setDrafts((current) => {
      const next = new Map(current);
      for (const [key, fresh] of stored) {
        const was = current.get(key);
        // A level this screen saved after the refresh was asked for is newer: keep it.
        if (was?.version != null && fresh.version !== null && fresh.version < was.version) continue;
        if (was === undefined) next.set(key, fresh);
        else {
          const adopted = { ...was, onHand: fresh.onHand, version: fresh.version };
          // A level that is clean once reloaded shows what is stored, without the old message.
          next.set(key, isDirty(adopted) ? adopted : fresh);
        }
      }
      return next;
    });
  }, [view]);

  const update = (key: string, change: Partial<Draft>) =>
    setDrafts((current) => {
      const next = new Map(current);
      next.set(key, { ...(current.get(key) ?? EMPTY), ...change });
      return next;
    });

  const editable = (cell: StockCell | undefined) => canEdit && cell?.retired !== true;
  const order = view.variants.flatMap((variant) =>
    sources.flatMap((source) => {
      const cell = variant.sources.find((item) => item.sourceId === source.id);
      return editable(cell) ? [{ key: keyOf(variant.variantId, source.id), variant, source }] : [];
    }),
  );
  const changed = order.filter(({ key }) => isDirty(drafts.get(key) ?? EMPTY));

  async function saveOne(key: string, variantId: string, sourceId: string): Promise<SectionResult> {
    const draft = latest.current.get(key) ?? EMPTY;
    const onHand = onHandOf(draft.text);
    if (onHand === null) return 'failed';
    const result = await callApi<StockSet>(
      'PUT',
      `inventory/seller/offers/${offerId}/variants/${variantId}/sources/${sourceId}/stock`,
      { onHand, expectedVersion: draft.version },
      csrfToken,
    );
    if (result.ok) {
      update(key, {
        onHand: result.body.onHand,
        version: result.body.version,
        text: String(result.body.onHand),
        problem: null,
        staleAt: null,
      });
      return 'saved';
    }
    if (result.failure.status === 401) {
      flushSync(() => setLeaving(true));
      window.location.assign('/session-ended');
      return 'stopped';
    }
    const problem = levelsProblemOf(result.failure);
    update(key, { problem, staleAt: problem === 'stale' ? draft.version : null });
    // The level changed elsewhere: read it again; the cell takes the new version, the number stays.
    if (problem === 'stale') router.refresh();
    return 'failed';
  }

  const saves = useSectionSaves(
    changed.map(({ key, variant, source }) => ({
      key,
      dirty: true,
      save: () => saveOne(key, variant.variantId, source.id),
    })),
  );

  const guard = useUnsavedChangesGuard(
    saves.count > 0 && !leaving,
    {
      title: t('settings.leave.title'),
      message: (info) => t('settings.leave.message', { count: info.count, page: info.page }),
      stay: t('settings.leave.stay'),
      leave: t('settings.leave.leave'),
    },
    { count: saves.count, page: t('stock.levels.title') },
  );

  async function submit() {
    if (saves.saving || changed.length === 0) return;
    // Every wrong number shows its message at once; nothing is sent while one is wrong.
    let ok = true;
    for (const { key } of changed) {
      const wrong = onHandOf((drafts.get(key) ?? EMPTY).text) === null;
      if (wrong) ok = false;
      update(key, { problem: wrong ? 'invalid' : null, staleAt: null });
    }
    if (!ok) {
      setFocusTick((tick) => tick + 1);
      return;
    }
    const result = await saves.saveAll();
    if (result === null || result.stopped) return;
    const saved = result.saved.length;
    if (result.failed.length === 0) {
      toast.success(
        saved === 1 ? t('stock.levels.saved') : t('stock.levels.saved-many', { count: saved }),
      );
      return;
    }
    if (saved > 0) {
      toast.warning(t('stock.levels.partial', { saved, failed: result.failed.length }));
    } else toast.error(t('stock.levels.failed', { count: result.failed.length }));
    setFocusTick((tick) => tick + 1);
  }

  function discard() {
    setDrafts((current) => {
      const next = new Map(current);
      for (const [key, draft] of current) {
        next.set(key, { ...draft, text: String(draft.onHand ?? ''), problem: null, staleAt: null });
      }
      return next;
    });
  }

  if (sources.length === 0) {
    return (
      <Banner tone="attention">
        <p>{t('stock.levels.no-locations')}</p>
        <a className="font-medium text-link underline" href="/settings/stock-locations">
          {t('stock.title')}
        </a>
      </Banner>
    );
  }
  if (view.variants.length === 0) {
    return <p className="text-fg-muted">{t('stock.levels.no-variants')}</p>;
  }
  return (
    <form
      ref={formRef}
      noValidate
      className="flex flex-col gap-4"
      onSubmit={(event) => {
        event.preventDefault();
        void submit();
      }}
    >
      {/* Nothing changes while the levels are sent, so each sends the number on screen at Save. */}
      <fieldset disabled={saves.saving} className="m-0 flex min-w-0 flex-col gap-4 border-0 p-0">
        {view.variants.map((variant, index) => (
          <Card key={variant.variantId} title={t('stock.levels.variant', { number: index + 1 })}>
            <div className="max-w-(--mp-size-form-max)">
              <ul className="flex flex-col gap-4">
                {sources.map((source) => {
                  const cell = variant.sources.find((item) => item.sourceId === source.id);
                  const key = keyOf(variant.variantId, source.id);
                  return (
                    <li key={source.id} className="flex flex-col gap-2">
                      <h3 className="break-words font-medium text-fg">{source.name}</h3>
                      <Cell
                        variantId={variant.variantId}
                        source={source}
                        cell={cell}
                        draft={drafts.get(key) ?? EMPTY}
                        editable={editable(cell)}
                        onText={(text) => update(key, { text, problem: null, staleAt: null })}
                      />
                    </li>
                  );
                })}
              </ul>
            </div>
          </Card>
        ))}
      </fieldset>
      {canEdit ? (
        <SaveBar
          count={saves.count}
          summary={t('settings.bar.summary', { count: saves.count })}
          saving={saves.saving}
          aboveBottomBar
          labels={{
            region: t('settings.bar.region'),
            discard: t('settings.bar.discard'),
            save: t('settings.bar.save'),
            saving: t('settings.bar.saving'),
          }}
          onDiscard={discard}
        />
      ) : null}
      {saves.count > 0 ? guard.dialog : null}
    </form>
  );
}

/** Focuses the first field marked invalid inside the form. */
function focusFirstInvalid(form: HTMLFormElement | null) {
  const target = form?.querySelector<HTMLElement>('[aria-invalid="true"]');
  target?.focus();
  target?.scrollIntoView?.({ block: 'center' });
}
