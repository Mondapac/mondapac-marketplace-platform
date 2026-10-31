// The Import products page (catalog design 14a): the shapes of the API's answers and the small
// rules the page applies to them. The API owns every number and code; the page only words them.

export const IMPORT_PERMISSION = 'catalog.platform-import.run';
export const PAUSE_PERMISSION = 'catalog.product.pause';
export const IMPORT_BASE = 'catalog/admin/platform-imports';
export const LIST_PATH = '/catalog/products';

export type ImportState = 'checked' | 'queued' | 'running' | 'finished' | 'stopped' | 'discarded';
export type StartAs = 'inactive' | 'active';

export interface ImportErrorLine {
  readonly rowNumber: number;
  /** A column key (`title`, `category`...) or `row`. */
  readonly column: string;
  readonly code: string;
  readonly value: string;
  readonly otherRow: number | null;
}

export interface ImportFailureLine {
  readonly rowNumber: number;
  readonly title: string;
  readonly code: string;
}

export interface ImportPreviewRow {
  readonly rowNumber: number;
  readonly title: string;
  readonly category: string;
  readonly typeCode: string;
  readonly brand: string;
}

export interface ImportView {
  readonly id: string;
  readonly state: ImportState;
  readonly fileLabel: string;
  readonly fileBytes: number;
  readonly rows: number;
  readonly ready: number;
  readonly errors: number;
  readonly warnings: number;
  readonly ignoredColumns: readonly { readonly header: string; readonly certification: boolean }[];
  readonly startAs: StartAs | null;
  readonly skipErrors: boolean | null;
  readonly toImport: number | null;
  readonly added: number;
  readonly failed: number;
  readonly stopReason: string | null;
  readonly canResume: boolean;
  readonly checkedAt: string;
  readonly startedAt: string | null;
  readonly finishedAt: string | null;
  readonly durationSeconds: number | null;
  readonly errorLines: readonly ImportErrorLine[];
  readonly failureLines: readonly ImportFailureLine[];
  readonly preview: readonly ImportPreviewRow[];
}

export interface ImportTemplate {
  readonly columns: readonly {
    readonly key: string;
    readonly header: string;
    readonly required: boolean;
  }[];
  readonly typesOffered: readonly string[];
  readonly limits: { readonly rows: number; readonly fileBytes: number };
  readonly filename: string;
  readonly csv: string;
  /** The same template as an XLSX file (standard base64) and its file name. */
  readonly xlsxFilename: string;
  readonly xlsx: string;
}

/** The step of the bar a state belongs to (1 Upload file, 2 Check file, 3 Import). */
export function stepOf(state: ImportState | 'upload' | 'checking'): 1 | 2 | 3 {
  switch (state) {
    case 'upload':
      return 1;
    case 'checking':
    case 'checked':
    case 'discarded':
      return 2;
    default:
      return 3;
  }
}

/** True while the worker still has rows to do: the page polls. */
export function isActive(state: ImportState): boolean {
  return state === 'queued' || state === 'running';
}

/** Whether the Import button may be pressed: ready rows, and errors only with the explicit skip. */
export function canImport(view: Pick<ImportView, 'ready' | 'errors'>, skip: boolean): boolean {
  return view.ready > 0 && (view.errors === 0 || skip);
}

/** A key of the messages for an API code: dots are not allowed in a message key. */
export function keyOfCode(code: string): string {
  return code.replaceAll('.', '-');
}

/** A refusal of the upload, as the page shows it under the file. */
export interface UploadProblem {
  readonly tone: 'critical' | 'attention';
  readonly key: string;
  readonly values: Readonly<Record<string, string | number>>;
}

/** Words the API's refusal of a check (the states board of the design). */
export function uploadProblemOf(failure: {
  readonly status: number;
  readonly code: string;
  readonly details?: {
    readonly retryAfterSeconds?: number;
    readonly columns?: readonly string[];
    readonly rows?: number;
    readonly max?: number;
    readonly maxBytes?: number;
    readonly rowNumber?: number;
    readonly fields?: readonly { readonly path: string; readonly code: string }[];
  };
}): UploadProblem {
  const details = failure.details ?? {};
  switch (failure.code) {
    case 'file.unsupported-type':
      return { tone: 'critical', key: 'wrong-type', values: {} };
    case 'file.too-large':
      return {
        tone: 'critical',
        key: 'too-large-bytes',
        values: { size: Math.round((details.maxBytes ?? 10 * 1024 * 1024) / (1024 * 1024)) },
      };
    case 'file.unpacked-too-large':
      return { tone: 'critical', key: 'unpacked-too-large', values: {} };
    case 'file.too-complex':
      return { tone: 'critical', key: 'too-complex', values: {} };
    case 'file.busy':
      return { tone: 'attention', key: 'busy', values: {} };
    case 'file.formula-cell':
      return { tone: 'critical', key: 'formula', values: { row: details.rowNumber ?? 0 } };
    case 'file.too-many-rows':
      return {
        tone: 'critical',
        key: 'too-many-rows',
        values: { rows: details.rows ?? 0, max: details.max ?? 5000 },
      };
    case 'columns.missing':
      return {
        tone: 'critical',
        key: 'columns-missing',
        values: { column: details.columns?.[0] ?? '' },
      };
    case 'columns.duplicate':
      return {
        tone: 'critical',
        key: 'columns-duplicate',
        values: { column: details.columns?.[0] ?? '' },
      };
    case 'file.empty':
    case 'file.no-rows':
      return { tone: 'attention', key: 'empty', values: {} };
    case 'file.unreadable':
    case 'file.too-many-columns':
    case 'file.cell-too-long':
      return { tone: 'critical', key: 'unreadable', values: {} };
    case 'request.throttled':
      return {
        tone: 'attention',
        key: 'throttled',
        values: { minutes: Math.max(1, Math.ceil((details.retryAfterSeconds ?? 60) / 60)) },
      };
    case 'access.denied':
      return { tone: 'critical', key: 'denied', values: {} };
    default:
      return { tone: 'critical', key: 'unavailable', values: {} };
  }
}
