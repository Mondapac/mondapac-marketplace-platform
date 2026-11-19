'use client';

import { Button, Select, TextField } from '@mondapac/ui';
import { useTranslations } from 'next-intl';
import { useCallback, useRef, useState } from 'react';
import { callApi, type ApiResult } from '../api/client.ts';
import type { SellerListPage, SellerRow } from '../sellers/types.ts';

// Store names for the customers screens that hold only a seller id (the suspicious attributions
// rows, the "Store followed" chip) and a store picker for their filters. Both read the sellers
// list (`sellers/admin/list`); a role that may not read it gets the short id and no picker search
// result, never an error: the name is a convenience, the id is the filter.

/** The key `sellers/admin/list` needs: without it the picker and name lookups are left out. */
export const SELLERS_VIEW_PERMISSION = 'sellers.seller.view';

const PAGE = 50;
/** At most this many pages are read to name the ids on one screen. */
const PAGES_MAX = 6;

/** A seller id as a short code for a link whose name is not known ("Seller 0190a000"). */
export const shortId = (sellerId: string): string => sellerId.slice(0, 8);

export interface SellerNames {
  readonly names: ReadonlyMap<string, string>;
  readonly remember: (sellerId: string, name: string) => void;
  /** Reads the names of ids not known yet (each id is tried once per page load). */
  readonly resolve: (sellerIds: readonly string[], csrfToken: string) => Promise<void>;
}

export function useSellerNames(): SellerNames {
  const [names, setNames] = useState<ReadonlyMap<string, string>>(new Map());
  const tried = useRef(new Set<string>());
  const known = useRef(new Map<string, string>());

  const remember = useCallback((sellerId: string, name: string) => {
    known.current.set(sellerId, name);
    setNames(new Map(known.current));
  }, []);

  const resolve = useCallback(async (sellerIds: readonly string[], csrfToken: string) => {
    const wanted = new Set(
      sellerIds.filter((id) => !known.current.has(id) && !tried.current.has(id)),
    );
    if (wanted.size === 0) return;
    for (const id of wanted) tried.current.add(id);
    let after: string | null = null;
    for (let page = 0; page < PAGES_MAX && wanted.size > 0; page += 1) {
      const result: ApiResult<SellerListPage> = await callApi<SellerListPage>(
        'POST',
        'sellers/admin/list',
        { tab: 'all', limit: PAGE, ...(after === null ? {} : { after }) },
        csrfToken,
      );
      if (!result.ok) return;
      for (const row of result.body.items) {
        if (wanted.delete(row.sellerId) && row.storeName !== null) {
          known.current.set(row.sellerId, row.storeName);
        }
      }
      setNames(new Map(known.current));
      after = result.body.next;
      if (after === null) return;
    }
  }, []);

  return { names, remember, resolve };
}

/**
 * A store picker for a filter: type part of the store name and search, choose one store from the
 * answer; the chosen store shows with Change. Reads `sellers/admin/list` (search over the file).
 */
export function SellerPicker({
  label,
  value,
  name,
  csrfToken,
  onChange,
}: {
  readonly label: string;
  /** The chosen seller id, or '' for any. */
  readonly value: string;
  /** The chosen store's name when known. */
  readonly name: string | null;
  readonly csrfToken: string;
  readonly onChange: (sellerId: string, name: string | null) => void;
}) {
  const t = useTranslations('customers.seller-picker');
  const [term, setTerm] = useState('');
  const [found, setFound] = useState<readonly SellerRow[] | null>(null);
  const [state, setState] = useState<'idle' | 'busy' | 'failed'>('idle');
  const [changing, setChanging] = useState(false);

  async function search() {
    const text = term.trim();
    if (text.length < 2) return;
    setState('busy');
    const result = await callApi<SellerListPage>(
      'POST',
      'sellers/admin/list',
      { tab: 'all', limit: 20, search: text },
      csrfToken,
    );
    if (!result.ok) {
      setFound(null);
      setState('failed');
      return;
    }
    setFound(result.body.items);
    setState('idle');
  }

  if (value !== '' && !changing) {
    return (
      <div className="flex flex-col gap-1">
        <span className="text-sm font-medium text-fg">{label}</span>
        <div className="flex flex-wrap items-center gap-2">
          <span className="wrap-anywhere">{name ?? t('unknown', { id: shortId(value) })}</span>
          <Button variant="link" size="sm" onClick={() => setChanging(true)}>
            {t('change')}
          </Button>
          <Button variant="link" size="sm" onClick={() => onChange('', null)}>
            {t('clear')}
          </Button>
        </div>
      </div>
    );
  }

  return (
    <fieldset className="flex flex-col gap-2">
      <legend className="mb-1 text-sm font-medium text-fg">{label}</legend>
      <div className="flex items-end gap-2">
        <div className="min-w-0 flex-1">
          <TextField
            label={t('search')}
            value={term}
            help={t('help')}
            onChange={(event) => setTerm(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Enter') {
                event.preventDefault();
                void search();
              }
            }}
          />
        </div>
        <Button
          variant="secondary"
          loading={state === 'busy'}
          disabled={term.trim().length < 2}
          onClick={() => void search()}
        >
          {t('find')}
        </Button>
      </div>
      {state === 'failed' ? (
        <p role="alert" className="text-sm text-critical-fg">
          {t('failed')}
        </p>
      ) : null}
      {found === null ? null : found.length === 0 ? (
        <p role="status" className="text-sm text-fg-muted">
          {t('none')}
        </p>
      ) : (
        <Select
          label={t('results')}
          value=""
          placeholder={t('choose', { count: found.length })}
          options={found.map((row) => ({
            value: row.sellerId,
            label: row.storeName ?? t('unknown', { id: shortId(row.sellerId) }),
          }))}
          onChange={(event) => {
            const row = found.find((item) => item.sellerId === event.target.value);
            if (row === undefined) return;
            setChanging(false);
            onChange(row.sellerId, row.storeName);
          }}
        />
      )}
    </fieldset>
  );
}
