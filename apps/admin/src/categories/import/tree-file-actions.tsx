'use client';

import { Button, LinkButton } from '@mondapac/ui';
import { useTranslations } from 'next-intl';
import { IMPORT_PAGE_PATH } from './import-model.ts';
import { useTreeExport } from './use-tree-export.ts';

/** Export of the tree as a file, and the way to the import page: for a holder of the import key. */
export function TreeFileActions() {
  const t = useTranslations('categories.export');
  const { exporting, run } = useTreeExport(t('failed'));
  return (
    <div className="flex flex-wrap items-center gap-2" role="group" aria-label={t('group')}>
      <Button
        variant="secondary"
        loading={exporting === 'csv'}
        disabled={exporting === 'xlsx'}
        aria-label={t('csv-label')}
        onClick={() => void run('csv')}
      >
        {t('csv')}
      </Button>
      <Button
        variant="secondary"
        loading={exporting === 'xlsx'}
        disabled={exporting === 'csv'}
        aria-label={t('xlsx-label')}
        onClick={() => void run('xlsx')}
      >
        {t('xlsx')}
      </Button>
      <LinkButton variant="secondary" href={IMPORT_PAGE_PATH}>
        {t('import')}
      </LinkButton>
    </div>
  );
}
