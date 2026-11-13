import { money, ok, Temporal } from '@mondapac/shared-kernel';
import { FixedClock } from '@mondapac/shared-kernel/testing';
import { csvLine, decimalOf, ORDERS_EXPORT_MAX_ROWS } from './orders-csv';
import { EXPORT_PAGE, ordersExport, type ExportPage, type PageReader } from './orders-export';

const clock = new FixedClock(Temporal.Instant.from('2026-11-06T10:00:00Z'));

const spec = (read: PageReader) => ({
  allowed: new Set(['status']),
  header: ['A', 'B'],
  name: 'orders',
  read,
});

const text = async (chunks: AsyncIterable<string>) => {
  let out = '';
  for await (const chunk of chunks) out += chunk;
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
        ok<ExportPage>({ rows: [], nextCursor: null, total: ORDERS_EXPORT_MAX_ROWS + 1 }),
      );
    };
    const result = await ordersExport(clock, {}, spec(read));
    expect(result).toEqual({
      ok: false,
      error: { code: 'batch.too-large', max: ORDERS_EXPORT_MAX_ROWS, matching: 10_001 },
    });
    expect(calls).toBe(1);
  });

  it('allows the cap exactly', async () => {
    const read: PageReader = () =>
      Promise.resolve(
        ok<ExportPage>({ rows: [], nextCursor: null, total: ORDERS_EXPORT_MAX_ROWS }),
      );
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
});
