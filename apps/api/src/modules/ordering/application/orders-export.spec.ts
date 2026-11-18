import { money, ok, Temporal } from '@mondapac/shared-kernel';
import { FixedClock } from '@mondapac/shared-kernel/testing';
import { csvLine } from '@mondapac/platform-import';
import { Workbook } from 'exceljs';
import { LIST_EXPORT_MAX_ROWS } from '../../../platform/list-export';
import { decimalOf } from './orders-csv';
import { EXPORT_PAGE, ordersExport, type ExportPage, type PageReader } from './orders-export';

const clock = new FixedClock(Temporal.Instant.from('2026-11-06T10:00:00Z'));

const spec = (read: PageReader) => ({
  allowed: new Set(['status']),
  header: ['A', 'B'],
  name: 'orders',
  read,
  columns: { fixed: 1, optional: { b: 1 } },
  notFound: 'ordering.order-not-found' as const,
});

const text = async (chunks: AsyncIterable<string | Uint8Array>) => {
  let out = '';
  for await (const chunk of chunks) out += String(chunk);
  return out;
};

describe('order export csv', () => {
  it('writes a minor-unit amount as an exact decimal', () => {
    expect(decimalOf(money(1250n, 'AUD'))).toBe('12.50');
    expect(decimalOf(money(5n, 'AUD'))).toBe('0.05');
    expect(decimalOf(money(0n, 'AUD'))).toBe('0.00');
    expect(decimalOf(money(-300n, 'AUD'))).toBe('-3.00');
    expect(decimalOf(money(1200n, 'JPY'))).toBe('1200');
  });

  it('quotes a comma, a quote and a line break, and defuses a formula', () => {
    expect(csvLine(['a,b', 'say "hi"', 'x\ny', '=1+1', '@x', '-2', null, 3])).toBe(
      '"a,b","say ""hi""","x\ny",\'=1+1,\'@x,\'-2,,3\r\n',
    );
  });
});

describe('ordersExport', () => {
  it('reads the count first, then streams every page through the cursor', async () => {
    const calls: Record<string, unknown>[] = [];
    const read: PageReader = (extra) => {
      calls.push(extra);
      if (extra['page'] === 1) {
        return Promise.resolve(ok<ExportPage>({ rows: [], nextCursor: null, total: 3 }));
      }
      const second = extra['cursor'] === 'c1';
      return Promise.resolve(
        ok<ExportPage>({
          rows: second
            ? [['3', 'z']]
            : [
                ['1', 'x'],
                ['2', 'y'],
              ],
          nextCursor: second ? null : 'c1',
          total: null,
        }),
      );
    };
    const result = await ordersExport(clock, { status: 'confirmed' }, spec(read));
    if (!result.ok) throw new Error('refused');

    expect(result.value.filename).toBe('orders-2026-11-06.csv');
    expect(await text(result.value.chunks)).toBe('﻿A,B\r\n1,x\r\n2,y\r\n3,z\r\n');
    expect(calls).toEqual([
      { status: 'confirmed', page: 1, pageSize: 1 },
      { status: 'confirmed', limit: EXPORT_PAGE },
      { status: 'confirmed', limit: EXPORT_PAGE, cursor: 'c1' },
    ]);
  });

  it('refuses a request over the cap whole, before any row is read', async () => {
    let calls = 0;
    const read: PageReader = () => {
      calls += 1;
      return Promise.resolve(
        ok<ExportPage>({ rows: [], nextCursor: null, total: LIST_EXPORT_MAX_ROWS + 1 }),
      );
    };
    const result = await ordersExport(clock, {}, spec(read));
    expect(result).toEqual({
      ok: false,
      error: { code: 'batch.too-large', max: LIST_EXPORT_MAX_ROWS, matching: 10_001 },
    });
    expect(calls).toBe(1);
  });

  it('allows the cap exactly', async () => {
    const read: PageReader = () =>
      Promise.resolve(ok<ExportPage>({ rows: [], nextCursor: null, total: LIST_EXPORT_MAX_ROWS }));
    expect((await ordersExport(clock, {}, spec(read))).ok).toBe(true);
  });

  it('refuses unknown keys without reading', async () => {
    let calls = 0;
    const read: PageReader = () => {
      calls += 1;
      return Promise.resolve(ok<ExportPage>({ rows: [], nextCursor: null, total: 0 }));
    };
    const result = await ordersExport(clock, { limit: 5, cursor: 'x' }, spec(read));
    expect(result).toEqual({
      ok: false,
      error: {
        code: 'validation.failed',
        fields: [
          { path: 'limit', code: 'unknown' },
          { path: 'cursor', code: 'unknown' },
        ],
      },
    });
    expect(calls).toBe(0);
  });

  it('fails the stream, not the header, when a later page cannot be read', async () => {
    let n = 0;
    const read: PageReader = () => {
      n += 1;
      if (n === 1) return Promise.resolve(ok<ExportPage>({ rows: [], nextCursor: null, total: 2 }));
      return Promise.resolve({ ok: false, error: { code: 'access.unavailable' } } as const);
    };
    const result = await ordersExport(clock, {}, spec(read));
    if (!result.ok) throw new Error('refused');
    await expect(text(result.value.chunks)).rejects.toThrow(/the read failed/);
  });

  it('writes only the chosen columns after the fixed ones, in the order given', async () => {
    const read: PageReader = (extra) =>
      Promise.resolve(
        ok<ExportPage>(
          extra['page'] === 1
            ? { rows: [], nextCursor: null, total: 1 }
            : { rows: [['1', 'x', 'y', 'z']], nextCursor: null, total: null },
        ),
      );
    const wide = {
      ...spec(read),
      header: ['A', 'B', 'C', 'D'],
      columns: { fixed: 1, optional: { b: 1, c: 2, d: 3 } },
    };
    const run = async (input: Record<string, unknown>) => {
      const result = await ordersExport(clock, input, wide);
      if (!result.ok) throw new Error('refused');
      return text(result.value.chunks);
    };
    expect(await run({})).toBe('\uFEFFA,B,C,D\r\n1,x,y,z\r\n');
    expect(await run({ columns: 'd,b' })).toBe('\uFEFFA,D,B\r\n1,z,x\r\n');
    expect(await run({ columns: '' })).toBe('\uFEFFA\r\n1\r\n');
    expect(await ordersExport(clock, { columns: 'nope' }, wide)).toEqual({
      ok: false,
      error: { code: 'validation.failed', fields: [{ path: 'columns', code: 'value' }] },
    });
  });

  it('answers an XLSX file for format=xlsx and refuses another format', async () => {
    const read: PageReader = (extra) =>
      Promise.resolve(
        ok<ExportPage>(
          extra['page'] === 1
            ? { rows: [], nextCursor: null, total: 1 }
            : { rows: [['1', 'x']], nextCursor: null, total: null },
        ),
      );
    const result = await ordersExport(clock, { format: 'xlsx' }, spec(read));
    if (!result.ok) throw new Error('refused');
    expect(result.value.filename).toBe('orders-2026-11-06.xlsx');
    expect(result.value.contentType).toContain('spreadsheetml');
    const parts: Buffer[] = [];
    for await (const chunk of result.value.chunks) parts.push(Buffer.from(chunk));
    const workbook = new Workbook();
    await workbook.xlsx.load(Buffer.concat(parts) as unknown as ArrayBuffer);
    const rows = workbook.getWorksheet('orders')?.getSheetValues().slice(1);
    expect(rows).toEqual([
      [undefined, 'A', 'B'],
      [undefined, '1', 'x'],
    ]);
    expect(await ordersExport(clock, { format: 'pdf' }, spec(read))).toEqual({
      ok: false,
      error: { code: 'validation.failed', fields: [{ path: 'format', code: 'value' }] },
    });
  });

  describe('selected ids', () => {
    const A = '0190a000-0000-7000-8000-000000000001';
    const B = '0190a000-0000-7000-8000-000000000002';
    const reader = (known: Record<string, readonly (readonly (string | number)[])[]>) => {
      const calls: Record<string, unknown>[] = [];
      const read: PageReader = (extra) => {
        calls.push(extra);
        return Promise.resolve(
          ok<ExportPage>({ rows: known[String(extra['q'])] ?? [], nextCursor: null, total: null }),
        );
      };
      return { read, calls };
    };

    it('reads each id through the list and writes those rows in the order given', async () => {
      const { read, calls } = reader({ [A]: [['a', 'x']], [B]: [['b', 'y']] });
      const result = await ordersExport(clock, { ids: `${B},${A}` }, spec(read));
      if (!result.ok) throw new Error('refused');
      expect(await text(result.value.chunks)).toBe('﻿A,B\r\nb,y\r\na,x\r\n');
      expect(calls).toEqual([
        { q: B, limit: 2 },
        { q: A, limit: 2 },
      ]);
    });

    it('refuses the whole request when one id is not in the list, before any file', async () => {
      const { read } = reader({ [A]: [['a', 'x']] });
      expect(await ordersExport(clock, { ids: `${A},${B}` }, spec(read))).toEqual({
        ok: false,
        error: { code: 'ordering.order-not-found' },
      });
    });

    it('refuses a malformed, repeated or oversized selection without reading', async () => {
      const { read, calls } = reader({});
      const bad = await ordersExport(clock, { ids: 'x' }, spec(read));
      expect(bad).toEqual({
        ok: false,
        error: { code: 'validation.failed', fields: [{ path: 'ids', code: 'format' }] },
      });
      const twice = await ordersExport(clock, { ids: `${A},${A}` }, spec(read));
      expect(twice).toEqual({
        ok: false,
        error: { code: 'validation.failed', fields: [{ path: 'ids', code: 'duplicate' }] },
      });
      const many = Array.from(
        { length: 101 },
        (_, n) => `0190a000-0000-7000-8000-${String(n).padStart(12, '0')}`,
      ).join(',');
      const exactly = many.split(',').slice(0, 100).join(',');
      expect((await ordersExport(clock, { ids: exactly }, spec(reader({ a: [] }).read))).ok).toBe(
        false,
      );
      expect(await ordersExport(clock, { ids: many }, spec(read))).toEqual({
        ok: false,
        error: { code: 'batch.too-large', max: 100 },
      });
      expect(calls).toHaveLength(0);
    });
  });
});
