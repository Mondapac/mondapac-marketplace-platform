/**
 * The limits of an import file (catalog design 14, Hassan 19.2 item 7), shared by the seller
 * import and the admin platform import (14a). They are enforced in this order, each before the
 * next stage runs: the byte size before anything is read, the content sniff before the decode,
 * the row, column and cell limits while the file is tokenised, so an oversized or hostile file
 * never reaches the row checks.
 */
export const IMPORT_LIMITS = Object.freeze({
  /** The file as uploaded. */
  fileBytes: 10 * 1024 * 1024,
  /** What a compressed container (XLSX) may expand to, summed over its entries. A CSV is never inflated. */
  decompressedBytes: 50 * 1024 * 1024,
  /** Entries (parts) a container may hold. A real workbook has a few dozen. */
  containerEntries: 1000,
  /**
   * The largest unpacked-to-packed ratio of an entry (or of the whole container) that is at least
   * {@link ratioFloorBytes} unpacked. Ordinary sheet XML packs at 10 to 30 times; a bomb packs at
   * hundreds to thousands.
   */
  compressionRatio: 100,
  /** Below this many unpacked bytes the ratio is not looked at (small parts pack oddly). */
  ratioFloorBytes: 1024 * 1024,
  /**
   * Per-part limits on what one part of a container may unpack to (Hassan M-586-1): the sheet and
   * the shared strings at most 15 MiB each (5,000 rows of 64 realistic columns fit far below), any
   * other XML part (workbook, styles, relationships, content types) 5 MiB. A part of another kind
   * (a picture) is only held to the total above. Checked on the declared sizes before any unpack.
   */
  worksheetPartBytes: 15 * 1024 * 1024,
  sharedStringsPartBytes: 15 * 1024 * 1024,
  xmlPartBytes: 5 * 1024 * 1024,
  /** Data rows, the header row not counted. */
  rows: 5000,
  /** Characters in one cell. */
  cellChars: 10_000,
  /** Columns in the header row. */
  columns: 64,
});

export type ImportLimits = typeof IMPORT_LIMITS;
