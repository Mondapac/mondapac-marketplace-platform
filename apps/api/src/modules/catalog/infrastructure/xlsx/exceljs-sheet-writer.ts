import { PassThrough } from 'node:stream';
import { stream as excel } from 'exceljs';
import type { SheetWriter } from '../../application/ports/sheet-writer';

/** Resolves when the stream has drained, or when it closes or fails (nobody reads it any more). */
function drained(out: PassThrough): Promise<void> {
  return new Promise<void>((resolve) => {
    const done = (): void => {
      out.off('drain', done);
      out.off('close', done);
      out.off('error', done);
      resolve();
    };
    out.once('drain', done);
    out.once('close', done);
    out.once('error', done);
  });
}

/**
 * The exceljs adapter of {@link SheetWriter}: the streaming workbook writer into a pass-through
 * that the caller reads, so the file leaves while products are still being read. Rows are
 * committed one at a time, so memory holds the row in hand, not the sheet.
 *
 * **Formula-injection rule:** each cell is assigned a JavaScript `string`, which exceljs writes as
 * a text cell (`t="inlineStr"`); exceljs makes a formula only from an object with a `formula`
 * key, which this adapter never builds. A text that starts with `=`, `+`, `-` or `@` is therefore
 * text in the file, and nothing is prefixed or altered. No cell is a number, a date or a formula.
 */
export class ExceljsSheetWriter implements SheetWriter {
  xlsx(sheetName: string, rows: AsyncIterable<readonly string[]>): AsyncIterable<Uint8Array> {
    const out = new PassThrough();
    const workbook = new excel.xlsx.WorkbookWriter({
      stream: out,
      useStyles: false,
      useSharedStrings: false,
    });
    const sheet = workbook.addWorksheet(sheetName);
    void (async () => {
      try {
        let written = 0;
        for await (const row of rows) {
          // The client left (the reader closed the stream): stop; leaving the loop closes `rows`.
          if (out.destroyed) return;
          sheet.addRow(row.map((cell) => String(cell))).commit();
          // Backpressure: wait for the reader when the buffer is full, or until it leaves.
          if (out.writableNeedDrain) await drained(out);
          // Let the event loop run now and then, so a reader that left is noticed even when the
          // rows arrive without any real I/O wait.
          written += 1;
          if (written % 100 === 0) await new Promise<void>((resolve) => setImmediate(resolve));
        }
        if (out.destroyed) return;
        sheet.commit();
        await workbook.commit();
      } catch (error) {
        out.destroy(error instanceof Error ? error : new Error('xlsx write failed'));
      }
    })();
    return out;
  }
}
