'use client';

import { Card } from '@mondapac/ui';
import { useTranslations } from 'next-intl';

/** A card of the Add page that has nothing to show before the product exists: one helper line. */
export function AfterSaveCard({ title, text }: { readonly title: string; readonly text: string }) {
  return (
    <Card title={title}>
      <p className="text-sm text-fg-muted">{text}</p>
    </Card>
  );
}

/** The Images field of an Add page: photos are uploaded to the product, so they wait for the first save. */
export function ImagesAfterSave() {
  const t = useTranslations('catalog.productForm');
  return (
    <div className="flex flex-col gap-1.5">
      <p className="text-sm font-medium text-fg">{t('images.label')}</p>
      <p className="text-sm text-fg-muted">{t('create.images-after-save')}</p>
    </div>
  );
}
