import type { ApiFailure } from '../../api/client.ts';
import { IMPORT_BASE } from './import-types.ts';

export type ReportKind = 'errors' | 'full';

export type ReportResult =
  { readonly ok: true } | { readonly ok: false; readonly failure: ApiFailure };

/** Saves a text file in the browser under the given name. */
export function saveBlob(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = filename;
  document.body.append(link);
  link.click();
  link.remove();
  URL.revokeObjectURL(url);
}

/**
 * Downloads the check's error report (`errors`) or the run's full report (`full`) as a CSV file.
 * It is fetched rather than linked so a refusal (`import.report-unavailable`) can be worded on the
 * page instead of saving an error body as a file.
 */
export async function downloadReport(importId: string, kind: ReportKind): Promise<ReportResult> {
  let response: Response;
  try {
    response = await fetch(`/api/${IMPORT_BASE}/${importId}/report?kind=${kind}`, {
      method: 'GET',
      headers: { accept: 'text/csv' },
      credentials: 'same-origin',
      cache: 'no-store',
    });
  } catch {
    return { ok: false, failure: { status: 0, code: 'network' } };
  }
  if (!response.ok) {
    const parsed = (await response.json().catch((): unknown => null)) as {
      code?: unknown;
    } | null;
    return {
      ok: false,
      failure: {
        status: response.status,
        code: typeof parsed?.code === 'string' ? parsed.code : 'unknown',
      },
    };
  }
  saveBlob(await response.blob(), `import-${kind}-report.csv`);
  return { ok: true };
}
