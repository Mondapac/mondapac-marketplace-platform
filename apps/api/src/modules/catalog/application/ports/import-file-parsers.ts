import type { ImportFileParser } from '../../domain/platform-import/import-file';

/** The file formats an import accepts, tried in order by their content sniff (CSV, then XLSX). */
export type ImportFileParsers = readonly ImportFileParser[];

export const IMPORT_FILE_PARSERS = Symbol('CATALOG_IMPORT_FILE_PARSERS');
