'use client';

import {
  Banner,
  Button,
  CheckboxRow,
  Dialog,
  LoadError,
  SkeletonRows,
  TextAreaField,
  TextField,
} from '@mondapac/ui';
import { useTranslations } from 'next-intl';
import { useEffect, useState } from 'react';
import { callApi } from '../api/client.ts';
import { parseAliases } from './brand-form.ts';
import {
  API_BRANDS,
  MERGE_SOURCES_MAX,
  SOURCE_PAGE_SIZE,
  type BrandPage,
  type BrandRow,
  type MergeBody,
} from './types.ts';
import { useBrandCall } from './use-brand-call.ts';

/**
 * Merge other brands into one live brand: pick the brands to fold in (found by name), and add
 * spellings if needed. The picked brands are archived, their products move to the target, and
 * their names stay as aliases so search still finds them.
 */
export function BrandMergeDialog({
  target,
  csrfToken,
  onClose,
  onMerged,
  onStale,
}: {
  readonly target: BrandRow;
  readonly csrfToken: string;
  readonly onClose: () => void;
  readonly onMerged: (result: MergeBody) => void;
  readonly onStale: () => void;
}) {
  const t = useTranslations('brands.merge');
  const tr = useTranslations();
  const [search, setSearch] = useState('');
  const [found, setFound] = useState<readonly BrandRow[]>([]);
  const [load, setLoad] = useState<'loading' | 'ready' | 'failed'>('loading');
  const [picked, setPicked] = useState<ReadonlyMap<string, BrandRow>>(new Map());
  const [aliasText, setAliasText] = useState('');
  const call = useBrandCall(csrfToken);
  const aliases = parseAliases(aliasText);

  // The brands to pick from: live brands matching the typed name, after a short pause.
  useEffect(() => {
    let current = true;
    const timer = setTimeout(
      () => {
        const query = new URLSearchParams({ status: 'active', limit: String(SOURCE_PAGE_SIZE) });
        if (search.trim() !== '') query.set('search', search.trim());
        setLoad('loading');
        void callApi<BrandPage>('GET', `${API_BRANDS}?${query.toString()}`).then((result) => {
          if (!current) return;
          if (!result.ok) {
            if (result.failure.status === 401) window.location.assign('/session-ended');
            setLoad('failed');
            return;
          }
          setFound(result.body.items.filter((brand) => brand.id !== target.id));
          setLoad('ready');
        });
      },
      search === '' ? 0 : 300,
    );
    return () => {
      current = false;
      clearTimeout(timer);
    };
  }, [search, target.id]);

  function toggle(brand: BrandRow, on: boolean) {
    setPicked((previous) => {
      const next = new Map(previous);
      if (on) next.set(brand.id, brand);
      else next.delete(brand.id);
      return next;
    });
  }

  async function confirm() {
    const answer = await call.run<MergeBody>('POST', `${API_BRANDS}/${target.id}/merge`, {
      sourceBrandIds: [...picked.keys()],
      ...(aliases.aliases.length === 0 ? {} : { aliases: aliases.aliases }),
    });
    if (answer.ok) onMerged(answer.body);
  }

  const count = picked.size;
  const tooMany = count > MERGE_SOURCES_MAX;
  const problem = call.problem;
  return (
    <Dialog
      open
      title={t('title', { name: target.name })}
      onClose={onClose}
      actions={
        <>
          <Button variant="secondary" disabled={call.pending} onClick={onClose}>
            {t('cancel')}
          </Button>
          {problem?.reload === true ? (
            <Button onClick={onStale}>{tr('brands.form.reload')}</Button>
          ) : (
            <Button
              loading={call.pending}
              disabled={call.pending || count === 0 || tooMany || aliases.tooMany}
              onClick={() => void confirm()}
            >
              {t('confirm', { count })}
            </Button>
          )}
        </>
      }
    >
      <div className="flex flex-col gap-4">
        {problem === null ? null : (
          <Banner tone="critical">
            <p>{tr(problem.key)}</p>
            {problem.similar.length === 0 ? null : (
              <ul className="mt-2 list-disc ps-5">
                {problem.similar.map((name) => (
                  <li key={name} className="break-words">
                    {name}
                  </li>
                ))}
              </ul>
            )}
          </Banner>
        )}
        <p>{t('intro', { name: target.name })}</p>
        <TextField
          name="search"
          label={t('search')}
          value={search}
          autoComplete="off"
          onChange={(event) => setSearch(event.target.value)}
        />
        <fieldset className="flex flex-col gap-3">
          <legend className="mb-2 text-sm font-medium text-fg">{t('sources')}</legend>
          {load === 'loading' ? <SkeletonRows label={t('loading')} rows={3} /> : null}
          {load === 'failed' ? (
            <LoadError
              className="flex flex-col items-start gap-3"
              message={t('load-error')}
              retryLabel={tr('load.retry')}
            />
          ) : null}
          {load === 'ready' && found.length === 0 ? (
            <p className="text-fg-muted">{t('none')}</p>
          ) : null}
          {load === 'ready'
            ? found.map((brand) => (
                <CheckboxRow
                  key={brand.id}
                  label={brand.name}
                  help={`/brands/${brand.slug}`}
                  checked={picked.has(brand.id)}
                  onChange={(event) => toggle(brand, event.target.checked)}
                />
              ))
            : null}
        </fieldset>
        {count === 0 ? null : (
          <p className="text-sm text-fg-muted" aria-live="polite">
            {tooMany
              ? t('too-many', { max: MERGE_SOURCES_MAX })
              : t('picked', { names: [...picked.values()].map((brand) => brand.name).join(', ') })}
          </p>
        )}
        <TextAreaField
          name="aliases"
          label={t('aliases')}
          help={t('aliases-help', { name: target.name })}
          optionalLabel={t('optional')}
          value={aliasText}
          error={aliases.tooMany ? t('aliases-many') : undefined}
          onChange={(event) => setAliasText(event.target.value)}
        />
        <p className="text-sm text-fg-muted">{t('note')}</p>
      </div>
    </Dialog>
  );
}
