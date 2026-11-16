'use client';

import { LoadError, SkeletonRows } from '@mondapac/ui';
import { useTranslations } from 'next-intl';
import { useRouter } from 'next/navigation';
import { useCallback, useEffect, useState } from 'react';
import { callApi } from '../../api/client.ts';
import { EditForm } from './edit-form.tsx';
import { BASE, type ProductOptions, type ProductView } from './types.ts';

/** The product an Add page stands on before anything exists: the Market's categories and tax codes, but no fields yet (they come from the category's family). */
function blankProduct(options: ProductOptions): ProductView {
  return {
    productId: '',
    productCode: '',
    typeCode: '',
    familyCode: '',
    variantModel: 'single',
    status: 'draft',
    pausedAt: null,
    offers: { sellerCount: 0, offerCount: 0 },
    variants: [],
    maxVariants: 0,
    lastChangedAt: '',
    createdAt: '',
    form: {
      taxCategoryCodes: options.taxCategoryCodes,
      fields: [],
      categories: options.categories,
    },
    locales: options.locales,
    workingCopy: null,
    published: null,
  };
}

type Phase =
  | { readonly kind: 'loading' }
  | { readonly kind: 'failed' }
  | { readonly kind: 'ready'; readonly options: ProductOptions };

/**
 * The admin's "Add product" page: the same one-page form as Edit, empty. Only the Market's types
 * are read; nothing is created until the first Save draft.
 */
export function ProductAdd({
  csrfToken,
  marketName,
  timeZone,
  canReadTags,
  permissionKeys = [],
}: {
  readonly csrfToken: string;
  readonly marketName: string;
  readonly timeZone: string;
  readonly canReadTags: boolean;
  /** The admin's permission keys: the certificates card reads its own (view). */
  readonly permissionKeys?: readonly string[];
}) {
  const t = useTranslations('catalog.productForm');
  const router = useRouter();
  const [phase, setPhase] = useState<Phase>({ kind: 'loading' });
  // Bumped to start the form over (Discard on the unsaved bar).
  const [generation, setGeneration] = useState(0);

  const load = useCallback(async () => {
    setPhase({ kind: 'loading' });
    const result = await callApi<ProductOptions>('GET', `${BASE}/options`);
    if (result.ok) setPhase({ kind: 'ready', options: result.body });
    else if (result.failure.status === 401) window.location.assign('/session-ended');
    else setPhase({ kind: 'failed' });
  }, []);
  useEffect(() => {
    void load();
  }, [load]);

  if (phase.kind === 'loading') return <SkeletonRows label={t('loading')} rows={6} />;
  if (phase.kind === 'failed') {
    return (
      <LoadError message={t('load-failed')} retryLabel={t('retry')} onRetry={() => void load()} />
    );
  }
  return (
    <EditForm
      key={generation}
      creating={{ productTypes: phase.options.productTypes }}
      product={blankProduct(phase.options)}
      images={null}
      onCreated={(url) => router.replace(url)}
      csrfToken={csrfToken}
      marketName={marketName}
      timeZone={timeZone}
      canPause={false}
      canReadTags={canReadTags}
      permissionKeys={permissionKeys}
      onReload={() => setGeneration((value) => value + 1)}
    />
  );
}
