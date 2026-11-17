import { flashToast, saveFile } from '@mondapac/ui';
import { API_EXPORT } from './import-model.ts';

const XLSX_TYPE = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';

/** Reads the tree file from the API and hands it to the browser; a refusal shows as a toast. */
export async function exportTree(format: 'csv' | 'xlsx', failedText: string): Promise<void> {
  let response: Response;
  try {
    response = await fetch(`/api/${API_EXPORT}?format=${format}`, {
      credentials: 'same-origin',
      cache: 'no-store',
    });
  } catch {
    flashToast('error', failedText);
    return;
  }
  if (response.status === 401) {
    window.location.assign('/session-ended');
    return;
  }
  if (!response.ok) {
    flashToast('error', failedText);
    return;
  }
  const day = new Date().toISOString().slice(0, 10);
  // Bytes, not text: a text read would drop the byte-order mark that lets Excel open the CSV as UTF-8.
  const bytes = await response.arrayBuffer();
  const blob = new Blob([bytes], {
    type: format === 'xlsx' ? XLSX_TYPE : 'text/csv;charset=utf-8',
  });
  saveFile(blob, `category-tree-${day}.${format}`);
}
