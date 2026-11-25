'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import { callApi } from '../api/client.ts';
import type { CategoryTree } from '../catalog/products-types.ts';

// The dynamic options of the Offer review lists' seller and category filters. Categories come from
// the public tree, as on the Products list (without it the panel has no category field). Sellers
// come from the list answer itself: `sellers` names the stores that have rows in the queue,
// whatever the filters, so the options are exactly the stores a reviewer can narrow to.

export interface FilterOption {
  readonly value: string;
  readonly label: string;
}

/** The platform categories as options, indented by depth; empty until (and unless) they load. */
export function useCategoryOptions(): readonly FilterOption[] {
  const [categories, setCategories] = useState<CategoryTree['categories']>([]);
  useEffect(() => {
    let live = true;
    void callApi<CategoryTree>('GET', 'catalog/categories').then((result) => {
      if (live && result.ok && Array.isArray(result.body?.categories)) {
        setCategories(result.body.categories);
      }
    });
    return () => {
      live = false;
    };
  }, []);
  return useMemo(
    () =>
      categories.map((category) => ({
        value: category.id,
        label: `${'– '.repeat(category.depth)}${category.name}`,
      })),
    [categories],
  );
}

/** One store of a list answer's `sellers`. */
export interface QueueSeller {
  readonly sellerId: string;
  readonly storeName: string | null;
}

/**
 * The seller options of a list: the `sellers` of its answers. A store seen once stays an option for
 * the page's life, so the chip of a chosen store keeps its name after its last row is decided.
 */
export function useSellerOptions(unnamed: string): {
  readonly options: readonly FilterOption[];
  readonly take: (answer: unknown) => void;
} {
  const [sellers, setSellers] = useState<ReadonlyMap<string, string | null>>(new Map());
  const take = useCallback((answer: unknown) => {
    const listed = (answer as { sellers?: unknown }).sellers;
    if (!Array.isArray(listed)) return;
    setSellers((current) => {
      let next: Map<string, string | null> | null = null;
      for (const item of listed as QueueSeller[]) {
        if (typeof item?.sellerId !== 'string') continue;
        const name = typeof item.storeName === 'string' ? item.storeName : null;
        if (current.has(item.sellerId) && current.get(item.sellerId) === name) continue;
        next ??= new Map(current);
        next.set(item.sellerId, name);
      }
      return next ?? current;
    });
  }, []);
  const options = useMemo(
    () =>
      [...sellers]
        .map(([value, name]) => ({ value, label: name ?? `${unnamed} (${value.slice(0, 8)})` }))
        .sort((a, b) => a.label.localeCompare(b.label)),
    [sellers, unnamed],
  );
  return { options, take };
}
