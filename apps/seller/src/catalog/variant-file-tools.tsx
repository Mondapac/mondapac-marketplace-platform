'use client';

import { Banner, Button, CheckboxRow, Dialog, FileButton } from '@mondapac/ui';
import { useTranslations } from 'next-intl';
import { useState } from 'react';
import {
  exportVariantFile,
  FILE_LIMITS,
  readVariantFile,
  type CellChange,
  type FileModel,
  type FileRefusal,
  type ImportPreview,
} from './variant-file.ts';

/** `import.too-many-rows` becomes the message key `import-too-many-rows` (a dot is a path). */
const keyOf = (code: string): string => code.replaceAll('.', '-');

/**
 * Export and import of the offer's variant file (catalog design 14b), in the browser: the CSV is
 * built from what the tab already read, and a file the seller picks is read here, never sent to
 * the server. The preview shows only changed cells (current value, then file value); a stock
 * level that moved since the export is not applied unless the seller ticks it. "Apply" only fills
 * the drafts of the table; the tab's own Save writes them through the price and stock routes.
 */
export function VariantFileTools({
  model,
  disabled,
  onApply,
}: {
  readonly model: FileModel;
  readonly disabled: boolean;
  readonly onApply: (changes: readonly CellChange[]) => void;
}) {
  const t = useTranslations('catalog.variants-table.file');
  const [refusal, setRefusal] = useState<FileRefusal | null>(null);
  const [preview, setPreview] = useState<ImportPreview | null>(null);
  const [confirmed, setConfirmed] = useState<ReadonlySet<string>>(new Set());
  const canImport = model.canEditPrice || model.canEditStock;

  function download() {
    const blob = new Blob([exportVariantFile(model)], { type: 'text/csv;charset=utf-8' });
    const link = document.createElement('a');
    const url = URL.createObjectURL(blob);
    link.href = url;
    link.download = `variants-${model.productCode}-${new Date().toISOString().slice(0, 10)}.csv`;
    document.body.appendChild(link);
    link.click();
    link.remove();
    URL.revokeObjectURL(url);
  }

  async function pick(files: FileList | null) {
    const file = files?.[0];
    if (file === undefined) return;
    setRefusal(null);
    // The size is known before a byte is read.
    if (file.size > FILE_LIMITS.bytes) {
      setRefusal({ code: 'file.too-large', maxBytes: FILE_LIMITS.bytes });
      return;
    }
    const result = readVariantFile(new Uint8Array(await file.arrayBuffer()), model);
    if (!result.ok) {
      setRefusal(result.refusal);
      return;
    }
    setConfirmed(new Set());
    setPreview(result.preview);
  }

  function close() {
    setPreview(null);
    setConfirmed(new Set());
  }

  const stale = preview?.changes.filter((change) => change.code !== undefined) ?? [];
  const applicable =
    preview?.changes.filter((change) => change.code === undefined || confirmed.has(change.key)) ??
    [];
  const nameOf = (sourceId: string | undefined) =>
    model.sources.find((source) => source.id === sourceId)?.name ?? '';
  const where = (column?: string) => (column === undefined ? '' : column);

  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap items-center gap-2">
        <Button variant="secondary" disabled={disabled} onClick={download}>
          {t('export')}
        </Button>
        {canImport ? (
          <FileButton
            accept=".csv,text/csv"
            disabled={disabled}
            onFiles={(files) => void pick(files)}
          >
            {t('import')}
          </FileButton>
        ) : null}
      </div>
      {refusal === null ? null : (
        <Banner tone="critical">
          <p>
            {t(`refusal.${keyOf(refusal.code)}`, {
              max: 'max' in refusal ? refusal.max : 0,
              maxMb: 'maxBytes' in refusal ? Math.round(refusal.maxBytes / (1024 * 1024)) : 0,
              columns:
                'columns' in refusal && Array.isArray(refusal.columns)
                  ? refusal.columns.join(', ')
                  : '',
            })}
          </p>
        </Banner>
      )}
      <Dialog
        open={preview !== null}
        title={t('preview.title')}
        onClose={close}
        actions={
          <>
            <Button variant="secondary" onClick={close}>
              {t('preview.cancel')}
            </Button>
            <Button
              disabled={applicable.length === 0}
              onClick={() => {
                onApply(applicable);
                close();
              }}
            >
              {t('preview.apply', { count: applicable.length })}
            </Button>
          </>
        }
      >
        {preview === null ? null : (
          <div className="flex flex-col gap-4">
            <p>{t('preview.help')}</p>
            {preview.changes.length === 0 ? <p>{t('preview.none')}</p> : null}
            {preview.changes.length === 0 ? null : (
              <div
                className="overflow-x-auto"
                role="region"
                aria-label={t('preview.changes')}
                tabIndex={0}
              >
                <table className="w-full min-w-max text-start text-sm">
                  <thead>
                    <tr>
                      <th scope="col" className="p-2 text-start font-medium">
                        {t('preview.row')}
                      </th>
                      <th scope="col" className="p-2 text-start font-medium">
                        {t('preview.variant')}
                      </th>
                      <th scope="col" className="p-2 text-start font-medium">
                        {t('preview.cell')}
                      </th>
                      <th scope="col" className="p-2 text-start font-medium">
                        {t('preview.change')}
                      </th>
                    </tr>
                  </thead>
                  <tbody>
                    {preview.changes.map((change) => (
                      <tr key={change.key} className="border-t border-line align-top">
                        <td className="p-2">{change.rowNumber}</td>
                        <td className="p-2">{change.variantCode}</td>
                        <td className="p-2">
                          {change.kind === 'price'
                            ? t('preview.price')
                            : t('preview.stock', { location: nameOf(change.sourceId) })}
                        </td>
                        <td className="p-2">
                          <span>
                            {t('preview.from-to', { from: change.from || '-', to: change.to })}
                          </span>
                          {change.code === undefined ? null : (
                            <CheckboxRow
                              name={`confirm-${change.key}`}
                              label={t('preview.stock-changed')}
                              help={t('preview.stock-changed-help')}
                              checked={confirmed.has(change.key)}
                              onChange={(event) => {
                                const next = new Set(confirmed);
                                if (event.target.checked) next.add(change.key);
                                else next.delete(change.key);
                                setConfirmed(next);
                              }}
                            />
                          )}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
            {stale.length === 0 ? null : <p className="text-fg-muted">{t('preview.stale-help')}</p>}
            {preview.errors.length === 0 ? null : (
              <div role="alert" className="flex flex-col gap-1">
                <p className="font-medium">
                  {t('preview.errors', { count: preview.errors.length })}
                </p>
                <ul className="list-disc ps-5">
                  {preview.errors.map((issue, index) => (
                    <li key={`${issue.rowNumber}-${issue.code}-${index}`}>
                      {t('preview.issue', {
                        row: issue.rowNumber,
                        message: t(`issue.${keyOf(issue.code)}`, { column: where(issue.column) }),
                      })}
                    </li>
                  ))}
                </ul>
              </div>
            )}
            {preview.warnings.length === 0 ? null : (
              <div className="flex flex-col gap-1">
                <p className="font-medium">
                  {t('preview.warnings', { count: preview.warnings.length })}
                </p>
                <ul className="list-disc ps-5">
                  {preview.warnings.map((issue, index) => (
                    <li key={`${issue.rowNumber}-${issue.column ?? ''}-${index}`}>
                      {t('preview.issue', {
                        row: issue.rowNumber,
                        message: t(`issue.${keyOf(issue.code)}`, { column: where(issue.column) }),
                      })}
                    </li>
                  ))}
                </ul>
              </div>
            )}
            {preview.ignoredColumns.length === 0 ? null : (
              <p className="text-fg-muted">
                {t('preview.ignored', { columns: preview.ignoredColumns.join(', ') })}
              </p>
            )}
          </div>
        )}
      </Dialog>
    </div>
  );
}
