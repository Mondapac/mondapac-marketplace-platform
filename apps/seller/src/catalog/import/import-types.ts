// The Import page of Catalogue > Products (catalog design 14c): the shapes of the API's answers and
// the small rules the page applies to them. The API owns every number and code; the page only
// words them.

export const IMPORT_RUN_PERMISSION = 'catalog.own-import.run';
export const IMPORT_EDIT_PERMISSION = 'catalog.own-product.edit';
export const IMPORT_BASE = 'catalog/seller/imports';
export const IMPORT_ROOT = '/products/import';
export const LIST_PATH = '/products';

/** Both keys are needed to check, start, resume, discard or add a photo (design 14c, access rules). */
export function canRunImport(permissionKeys: readonly string[]): boolean {
  return (
    permissionKeys.includes(IMPORT_RUN_PERMISSION) &&
    permissionKeys.includes(IMPORT_EDIT_PERMISSION)
  );
}

export type ImportMode = 'my-products' | 'sell-from-catalogue';
export const IMPORT_MODES: readonly ImportMode[] = ['my-products', 'sell-from-catalogue'];

export type ImportState = 'checked' | 'queued' | 'running' | 'finished' | 'stopped' | 'discarded';

export type StopReason =
  'rate-limited' | 'access-lost' | 'seller-not-eligible' | 'file-missing' | 'unexpected';

export interface ImportErrorLine {
  readonly rowNumber: number;
  /** A column key (`title`, `category`, `option[colour]`...) or `row`. */
  readonly column: string;
  readonly code: string;
  readonly value: string;
  readonly otherRow: number | null;
}

export interface ImportFailureLine {
  readonly rowNumber: number;
  readonly sku: string;
  readonly code: string;
}

export interface ImportPreviewRow {
  readonly rowNumber: number;
  readonly sku: string;
  readonly title: string;
  readonly productCode: string;
  readonly typeCode: string;
  readonly options: string;
}

export interface IgnoredColumn {
  readonly header: string;
  /** `certification`: never imported. `elsewhere`: price, cost and stock are set in Prices and Stock. */
  readonly mark: 'certification' | 'elsewhere' | null;
}

export interface ImportView {
  readonly id: string;
  readonly mode: ImportMode;
  readonly state: ImportState;
  readonly fileLabel: string;
  readonly fileBytes: number;
  readonly format: 'csv' | 'xlsx';
  readonly rows: number;
  readonly ready: number;
  readonly errors: number;
  readonly warnings: number;
  /** Products (my-products) or Offers (sell-from-catalogue) in the file. */
  readonly groups: number;
  readonly ignoredColumns: readonly IgnoredColumn[];
  readonly skipErrors: boolean | null;
  readonly toImport: number | null;
  readonly created: number;
  readonly updated: number;
  readonly unchanged: number;
  readonly failed: number;
  readonly stopReason: StopReason | null;
  readonly canResume: boolean;
  readonly photoStepOpen: boolean;
  readonly checkedAt: string;
  readonly startedAt: string | null;
  readonly finishedAt: string | null;
  readonly durationSeconds: number | null;
  readonly errorLines: readonly ImportErrorLine[];
  readonly failureLines: readonly ImportFailureLine[];
  readonly preview: readonly ImportPreviewRow[];
}

export interface ImportTemplateMode {
  readonly mode: ImportMode;
  readonly columns: readonly {
    readonly key: string;
    readonly header: string;
    readonly required: boolean;
  }[];
  readonly filename: string;
  readonly csv: string;
  readonly xlsxFilename: string;
  /** The same template as an XLSX file, standard base64. */
  readonly xlsx: string;
}

export interface ImportTemplate {
  readonly modes: readonly ImportTemplateMode[];
  readonly typesOffered: readonly string[];
  readonly limits: { readonly rows: number; readonly fileBytes: number };
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

/**
 * Resume is offered only when the API says so and the stop is not a lost access: after
 * `import.access-lost` (or a suspension) a resume is refused, so the page offers a new import.
 */
export function canOfferResume(
  view: Pick<ImportView, 'state' | 'canResume' | 'stopReason'>,
): boolean {
  return (
    view.state === 'stopped' &&
    view.canResume &&
    view.stopReason !== 'access-lost' &&
    view.stopReason !== 'seller-not-eligible'
  );
}

/** A key of the messages for an API code: dots are not allowed in a message key. */
export function keyOfCode(code: string): string {
  return code.replaceAll('.', '-');
}

/** The column key of an error line, reduced to a message key (`option[colour]` is `option`). */
export function columnKeyOf(column: string): string {
  const bracket = column.indexOf('[');
  return bracket < 0 ? column : column.slice(0, bracket);
}

/** A refusal of the upload, as the page shows it under the file. */
export interface UploadProblem {
  readonly tone: 'critical' | 'attention';
  readonly key: string;
  readonly values: Readonly<Record<string, string | number>>;
  /** Column keys of the refused file (`columns.missing`, `columns.duplicate`), all of them. */
  readonly columns?: readonly string[];
}

export interface FailureLike {
  readonly status: number;
  readonly code: string;
  readonly details?: {
    readonly retryAfterSeconds?: number;
    readonly columns?: readonly string[];
    readonly rows?: number;
    readonly max?: number;
    readonly maxBytes?: number;
    readonly rowNumber?: number;
  };
}

/** Words the API's refusal of a check (every code the upload route returns). */
export function uploadProblemOf(failure: FailureLike): UploadProblem {
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
    case 'file.too-many-columns':
      return { tone: 'critical', key: 'too-many-columns', values: {} };
    case 'file.cell-too-long':
      return { tone: 'critical', key: 'cell-too-long', values: {} };
    case 'columns.missing':
      return {
        tone: 'critical',
        key: 'columns-missing',
        values: {},
        columns: details.columns ?? [],
      };
    case 'columns.duplicate':
      return {
        tone: 'critical',
        key: 'columns-duplicate',
        values: {},
        columns: details.columns ?? [],
      };
    case 'file.empty':
    case 'file.no-rows':
      return { tone: 'attention', key: 'empty', values: {} };
    case 'file.unreadable':
    case 'validation.failed':
      return { tone: 'critical', key: 'unreadable', values: {} };
    case 'setting.product-creation-off':
      return { tone: 'attention', key: 'creation-off', values: {} };
    case 'setting.sell-from-catalogue-off':
      return { tone: 'attention', key: 'catalogue-off', values: {} };
    case 'request.throttled':
      return {
        tone: 'attention',
        key: 'throttled',
        values: { minutes: Math.max(1, Math.ceil((details.retryAfterSeconds ?? 60) / 60)) },
      };
    case 'seller.not-eligible':
      return { tone: 'critical', key: 'not-eligible', values: {} };
    case 'access.acting-as-refused':
      return { tone: 'critical', key: 'acting-as', values: {} };
    case 'request.csrf':
    case 'session.invalid':
      return { tone: 'critical', key: 'session', values: {} };
    case 'access.denied':
      return { tone: 'critical', key: 'denied', values: {} };
    default:
      return { tone: 'critical', key: 'unavailable', values: {} };
  }
}

const ACTION_ERRORS: ReadonlySet<string> = new Set([
  'import.errors-not-skipped',
  'import.already-running',
  'import.not-confirmable',
  'import.nothing-to-import',
  'import.not-resumable',
  'import.access-lost',
  'import.not-discardable',
  'import.not-found',
  'import.report-unavailable',
  'import.daily-rows-reached',
  'request.throttled',
  'seller.not-eligible',
  'access.acting-as-refused',
  'access.denied',
  'request.csrf',
  'session.invalid',
]);

/** The message key (under `action-error`) of a refused start, resume, discard or report. */
export function actionErrorKey(failure: FailureLike): string {
  return ACTION_ERRORS.has(failure.code) ? keyOfCode(failure.code) : 'unavailable';
}

/** Whole seconds of a refusal's `retryAfterSeconds`, at least one; a minute when it has none. */
export function retryAfterOf(failure: FailureLike): number {
  const seconds = failure.details?.retryAfterSeconds;
  return typeof seconds === 'number' && Number.isFinite(seconds)
    ? Math.max(1, Math.ceil(seconds))
    : 60;
}
