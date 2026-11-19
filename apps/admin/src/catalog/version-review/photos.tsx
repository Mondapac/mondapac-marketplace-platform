'use client';

import { Badge, Banner, Button, Dialog, Select } from '@mondapac/ui';
import { useTranslations } from 'next-intl';
import { useRef, useState, type FormEvent } from 'react';
import { callApi } from '../../api/client.ts';
import { decisionProblemOf, type DecisionProblem } from './errors.ts';
import type { PhotoTile } from './diff.ts';
import { TAKEDOWN_REASONS } from './types.ts';

const imageSrc = (productId: string, imageId: string, size: 'thumb' | 'large') =>
  `/api/catalog/admin/products/${productId}/images/${imageId}/${size}`;

/**
 * The version's photos: each tile says whether it is new, kept or taken down (in words, with an
 * outline for new ones), opens large, and, for a reviewer who may decide, can be taken down after
 * a required reason and a warning that it cannot be undone. Removed photos are counted.
 */
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function PhotoTiles({
  productId,
  tiles,
  removed,
  canTakeDown,
  csrfToken,
}: {
  readonly productId: string;
  readonly tiles: readonly PhotoTile[];
  /** Photos of the published version that this version drops. */
  readonly removed: number;
  /** Holds catalog.product.delete: may take a photo down. */
  readonly canTakeDown: boolean;
  readonly csrfToken: string;
}) {
  const t = useTranslations('catalog.version.photos');
  const [takenDown, setTakenDown] = useState<ReadonlySet<string>>(new Set());
  const [large, setLarge] = useState<PhotoTile | null>(null);
  const [target, setTarget] = useState<PhotoTile | null>(null);
  const shown = tiles.map((tile) =>
    takenDown.has(tile.imageId) ? { ...tile, mark: 'taken-down' as const } : tile,
  );
  const name = (tile: PhotoTile) => t('name', { position: tile.position });

  return (
    <div className="flex flex-col gap-3">
      {shown.length === 0 ? <p className="text-fg-muted">{t('none')}</p> : null}
      <ul className="grid grid-cols-[repeat(auto-fill,minmax(9rem,1fr))] gap-3">
        {shown.map((tile) => (
          <li
            key={tile.imageId}
            className={`flex flex-col gap-2 rounded-lg border p-2 ${
              tile.mark === 'new' ? 'border-2 border-accent' : 'border-line'
            }`}
          >
            <div className="flex aspect-square items-center justify-center overflow-hidden rounded-md bg-muted">
              {tile.mark === 'taken-down' ? (
                <span className="px-2 text-center text-sm text-fg-muted">{t('not-served')}</span>
              ) : (
                <img
                  src={imageSrc(productId, tile.imageId, 'thumb')}
                  alt={name(tile)}
                  className="size-full object-cover"
                  loading="lazy"
                />
              )}
            </div>
            <div className="flex flex-wrap items-center gap-1">
              <span className="text-sm font-medium">{name(tile)}</span>
              <Badge
                tone={
                  tile.mark === 'new' ? 'info' : tile.mark === 'taken-down' ? 'critical' : 'neutral'
                }
              >
                {t(`mark.${tile.mark}`)}
              </Badge>
            </div>
            {tile.mark === 'taken-down' ? null : (
              <div className="flex flex-col gap-2">
                <Button
                  variant="secondary"
                  onClick={() => setLarge(tile)}
                  aria-label={t('view-named', { name: name(tile) })}
                >
                  {t('view')}
                </Button>
                {canTakeDown ? (
                  <Button
                    variant="destructive"
                    onClick={() => setTarget(tile)}
                    aria-label={t('take-down-named', { name: name(tile) })}
                  >
                    {t('take-down')}
                  </Button>
                ) : null}
              </div>
            )}
          </li>
        ))}
      </ul>
      {removed > 0 ? (
        <p className="text-sm text-fg-muted">{t('removed', { count: removed })}</p>
      ) : null}
      <Dialog
        open={large !== null}
        title={large === null ? '' : name(large)}
        onClose={() => setLarge(null)}
        actions={
          <Button variant="secondary" onClick={() => setLarge(null)}>
            {t('close')}
          </Button>
        }
      >
        {large === null ? null : (
          <img
            src={imageSrc(productId, large.imageId, 'large')}
            alt={name(large)}
            className="max-h-[70dvh] w-full rounded-md object-contain"
          />
        )}
      </Dialog>
      <TakeDownDialog
        productId={productId}
        tile={target}
        name={target === null ? '' : name(target)}
        csrfToken={csrfToken}
        onClose={() => setTarget(null)}
        onDone={(imageId) => {
          setTakenDown((current) => new Set(current).add(imageId));
          setTarget(null);
        }}
      />
    </div>
  );
}

function TakeDownDialog({
  productId,
  tile,
  name,
  csrfToken,
  onClose,
  onDone,
}: {
  readonly productId: string;
  readonly tile: PhotoTile | null;
  readonly name: string;
  readonly csrfToken: string;
  readonly onClose: () => void;
  readonly onDone: (imageId: string) => void;
}) {
  const t = useTranslations('catalog.version.photos');
  const te = useTranslations('catalog.version.error');
  const [reason, setReason] = useState('');
  const [missing, setMissing] = useState(false);
  const [pending, setPending] = useState(false);
  const [problem, setProblem] = useState<DecisionProblem | null>(null);
  const busy = useRef(false);
  const cancel = useRef<HTMLButtonElement>(null);

  const close = () => {
    if (busy.current) return;
    setReason('');
    setMissing(false);
    setProblem(null);
    onClose();
  };

  async function submit(event: FormEvent) {
    event.preventDefault();
    // The id is put in the path of a call that cannot be undone: only ever a UUID.
    if (tile === null || busy.current || !UUID.test(tile.imageId)) return;
    if (reason === '') {
      setMissing(true);
      return;
    }
    busy.current = true;
    setPending(true);
    setProblem(null);
    const result = await callApi<unknown>(
      'POST',
      `catalog/admin/products/${productId}/images/${tile.imageId}/take-down`,
      { reasonCode: reason },
      csrfToken,
    );
    busy.current = false;
    setPending(false);
    if (result.ok) {
      setReason('');
      onDone(tile.imageId);
      return;
    }
    if (result.failure.status === 401) {
      window.location.assign('/session-ended');
      return;
    }
    setProblem(decisionProblemOf(result.failure));
  }

  const formId = 'take-down-form';
  return (
    <Dialog
      open={tile !== null}
      title={t('take-down-title', { name })}
      onClose={close}
      initialFocus={cancel}
      actions={
        <>
          <Button ref={cancel} variant="secondary" onClick={close} disabled={pending}>
            {t('cancel')}
          </Button>
          <Button type="submit" form={formId} variant="destructive-solid" loading={pending}>
            {t('take-down-confirm')}
          </Button>
        </>
      }
    >
      <form
        id={formId}
        onSubmit={(event) => void submit(event)}
        className="flex flex-col gap-4"
        noValidate
      >
        <Banner tone="critical">{t('take-down-warning')}</Banner>
        {problem === null ? null : <Banner tone="critical">{te(problem)}</Banner>}
        <Select
          label={t('reason')}
          placeholder={t('reason-placeholder')}
          value={reason}
          required
          error={missing ? t('reason-missing') : undefined}
          onChange={(event) => {
            setReason(event.target.value);
            setMissing(false);
          }}
          options={TAKEDOWN_REASONS.map((code) => ({
            value: code,
            label: t(`reason-code.${code}`),
          }))}
        />
      </form>
    </Dialog>
  );
}
