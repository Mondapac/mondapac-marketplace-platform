'use client';

import { Banner, Button, Card, FieldAction, TextField, toast } from '@mondapac/ui';
import { useTranslations } from 'next-intl';
import { useRouter } from 'next/navigation';
import { useState, type FormEvent } from 'react';
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

function Cell({
  offerId,
  variantId,
  source,
  cell,
  canEdit,
  csrfToken,
}: {
  readonly offerId: string;
  readonly variantId: string;
  readonly source: SourceView;
  readonly cell: StockCell | undefined;
  readonly canEdit: boolean;
  readonly csrfToken: string;
}) {
  const t = useTranslations();
  const router = useRouter();
  const [saved, setSaved] = useState<{ onHand: number | null; version: number | null }>({
    onHand: cell?.onHand ?? null,
    version: cell?.version ?? null,
  });
  const [text, setText] = useState(cell === undefined ? '' : String(cell.onHand));
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const readOnly = !canEdit || cell?.retired === true;
  const label = t('stock.levels.on-hand');
  const help = t('stock.levels.held', { count: cell?.held ?? 0 });

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (pending) return;
    const onHand = onHandOf(text);
    if (onHand === null) {
      setError(t('stock.levels.error.invalid'));
      return;
    }
    setPending(true);
    setError(null);
    const result = await callApi<StockSet>(
      'PUT',
      `inventory/seller/offers/${offerId}/variants/${variantId}/sources/${source.id}/stock`,
      { onHand, expectedVersion: saved.version },
      csrfToken,
    );
    setPending(false);
    if (!result.ok) {
      if (result.failure.status === 401) window.location.assign('/session-ended');
      else {
        const problem = levelsProblemOf(result.failure);
        setError(t(`stock.levels.error.${problem}`));
        // The level changed elsewhere: read it again; the cell remounts on the new version.
        if (problem === 'stale') router.refresh();
      }
      return;
    }
    setSaved({ onHand: result.body.onHand, version: result.body.version });
    setText(String(result.body.onHand));
    toast.success(t('stock.levels.saved'));
  }

  if (readOnly) {
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
    <form className="flex flex-col gap-1" onSubmit={(event) => void submit(event)} noValidate>
      <div className="flex flex-wrap items-start gap-2">
        <div className="min-w-0 basis-full sm:flex-1 sm:basis-0">
          <TextField
            name={`onHand-${variantId}-${source.id}`}
            label={label}
            // The visible label sits under the location's heading; the name read out carries it.
            aria-label={t('stock.levels.on-hand-for', { location: source.name })}
            inputMode="numeric"
            value={text}
            error={error ?? undefined}
            onChange={(event) => {
              setText(event.target.value);
            }}
          />
        </div>
        <FieldAction>
          <Button
            type="submit"
            variant="secondary"
            loading={pending}
            disabled={pending || text.trim() === String(saved.onHand ?? '')}
          >
            {t('stock.levels.save')}
          </Button>
        </FieldAction>
      </div>
      {/* Under the whole row, so the field and Save keep one baseline. */}
      <span className="text-sm text-fg-muted">{help}</span>
    </form>
  );
}

/** Stock of one offer: a row per variant, a column per location, held units read only. */
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
    <div className="flex flex-col gap-4">
      {view.variants.map((variant, index) => (
        <Card key={variant.variantId} title={t('stock.levels.variant', { number: index + 1 })}>
          <div className="max-w-(--mp-size-form-max)">
            <ul className="flex flex-col gap-4">
              {sources.map((source) => {
                const cell = variant.sources.find((item) => item.sourceId === source.id);
                return (
                  <li key={source.id} className="flex flex-col gap-2">
                    <h3 className="break-words font-medium text-fg">{source.name}</h3>
                    <Cell
                      key={cell?.version ?? 'new'}
                      offerId={offerId}
                      variantId={variant.variantId}
                      source={source}
                      cell={cell}
                      canEdit={canEdit}
                      csrfToken={csrfToken}
                    />
                  </li>
                );
              })}
            </ul>
          </div>
        </Card>
      ))}
    </div>
  );
}
