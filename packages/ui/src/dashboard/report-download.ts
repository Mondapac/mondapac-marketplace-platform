import { saveFile } from '../list/export-dialog.tsx';

const XLSX_TYPE = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';

export type ReportFormat = 'csv' | 'xlsx';

/** Why a report download failed: `denied` (401 or 403), a refused query, or anything else. */
export class ReportDownloadError extends Error {
  constructor(readonly reason: 'denied' | 'invalid' | 'unavailable') {
    super(reason);
  }
}

/** The day in the given zone, for the name of a file. */
function dayIn(zone: string | null): string {
  try {
    return new Intl.DateTimeFormat('en-CA', {
      timeZone: zone ?? 'UTC',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    }).format(new Date());
  } catch {
    return new Date().toISOString().slice(0, 10);
  }
}

/** A file name from a `Content-Disposition`, with nothing that could leave the folder. */
export function safeFileName(name: string): string {
  return name.replace(/[^A-Za-z0-9._-]/g, '').replace(/^\.+/, '');
}

/**
 * Fetches a report file through the panel's relay (`/api/<path>?<query>`) and hands it to the
 * browser. A response that is not the file asked for (an HTML page from a proxy) is not saved.
 */
export async function downloadReport(input: {
  readonly path: string;
  readonly query: string;
  readonly format: ReportFormat;
  /** The start of the file name when the server names none. */
  readonly fallbackName: string;
  readonly zone: string | null;
}): Promise<void> {
  let response: Response;
  try {
    response = await fetch(`/api/${input.path}?${input.query}`, {
      credentials: 'same-origin',
      cache: 'no-store',
      // The relay answers itself; a redirect is never followed to another address.
      redirect: 'error',
    });
  } catch {
    throw new ReportDownloadError('unavailable');
  }
  if (response.status === 401 || response.status === 403) throw new ReportDownloadError('denied');
  if (!response.ok)
    throw new ReportDownloadError(response.status === 400 ? 'invalid' : 'unavailable');
  const type = (response.headers.get('content-type') ?? '').split(';')[0]?.trim().toLowerCase();
  if (type !== (input.format === 'xlsx' ? XLSX_TYPE : 'text/csv')) {
    throw new ReportDownloadError('unavailable');
  }
  const named = safeFileName(
    /filename="([^"]+)"/.exec(response.headers.get('content-disposition') ?? '')?.[1] ?? '',
  );
  const name = named === '' ? `${input.fallbackName}-${dayIn(input.zone)}.${input.format}` : named;
  try {
    if (input.format === 'xlsx') {
      saveFile(new Blob([await response.arrayBuffer()], { type: XLSX_TYPE }), name);
    } else {
      saveFile(new Blob([await response.text()], { type: 'text/csv;charset=utf-8' }), name);
    }
  } catch {
    throw new ReportDownloadError('unavailable');
  }
}
