import { err, ok } from '@mondapac/shared-kernel';
import { BULK_DECIDE_MAX, parseBulkItems, runBulkDecide } from './bulk-decide';

const id = (n: number): string => `01990000-0000-7000-8000-${String(n).padStart(12, '0')}`;

describe('parseBulkItems', () => {
  it('takes 1 to 50 rows in order', () => {
    const one = parseBulkItems([{ id: id(1), version: 3 }]);
    expect(one).toEqual({ ok: true, value: [{ id: id(1), version: 3 }] });
    const rows = Array.from({ length: BULK_DECIDE_MAX }, (_, i) => ({ id: id(i), version: 1 }));
    const full = parseBulkItems(rows);
    expect(full.ok && full.value.length).toBe(BULK_DECIDE_MAX);
  });

  it('refuses 51 distinct rows as too large', () => {
    const rows = Array.from({ length: BULK_DECIDE_MAX + 1 }, (_, i) => ({ id: id(i), version: 1 }));
    expect(parseBulkItems(rows)).toEqual({
      ok: false,
      error: { code: 'batch.too-large', max: BULK_DECIDE_MAX },
    });
  });

  it.each([
    ['not an array', 'x', 'items', 'type'],
    ['empty', [], 'items', 'required'],
    ['a non-object row', [1], 'items.0', 'type'],
    ['an unknown key', [{ id: id(1), version: 1, x: 1 }], 'items.0.x', 'unknown'],
    ['a bad id', [{ id: 'nope', version: 1 }], 'items.0.id', 'format'],
    ['version 0', [{ id: id(1), version: 0 }], 'items.0.version', 'type'],
    ['a fractional version', [{ id: id(1), version: 1.5 }], 'items.0.version', 'type'],
    ['a string version', [{ id: id(1), version: '1' }], 'items.0.version', 'type'],
    [
      'a repeated id in another case',
      [
        { id: id(1), version: 1 },
        { id: id(1).toUpperCase(), version: 1 },
      ],
      'items.1.id',
      'duplicate',
    ],
  ])('refuses %s', (_name, raw, path, code) => {
    expect(parseBulkItems(raw)).toEqual({
      ok: false,
      error: { code: 'validation.failed', fields: [{ path, code }] },
    });
  });
});

describe('runBulkDecide', () => {
  const rows = [1, 2, 3, 4, 5, 6].map((n) => ({ id: id(n), version: 1 }));

  it('keeps the order, counts each outcome and goes on after a refusal or a throw', async () => {
    const order: string[] = [];
    const answers: Record<string, () => ReturnType<typeof ok> | ReturnType<typeof err>> = {
      [id(1)]: () => ok(null),
      [id(2)]: () => err({ code: 'conflict.stale' }),
      [id(3)]: () => err({ code: 'suggestion.not-found' }),
      [id(4)]: () => err({ code: 'validation.failed' }),
      [id(5)]: () => {
        throw new Error('boom');
      },
      [id(6)]: () => ok(null),
    };
    const out = await runBulkDecide(rows, (item) => {
      order.push(item.id);
      return Promise.resolve(answers[item.id]!() as never);
    });
    expect(order).toEqual(rows.map((r) => r.id));
    expect(out.results).toEqual([
      { id: id(1), outcome: 'done' },
      { id: id(2), outcome: 'skipped', reason: 'conflict.stale' },
      { id: id(3), outcome: 'skipped', reason: 'suggestion.not-found' },
      { id: id(4), outcome: 'failed', reason: 'validation.failed' },
      { id: id(5), outcome: 'failed', reason: 'unexpected' },
      { id: id(6), outcome: 'done' },
    ]);
    expect(out.counts).toEqual({ done: 2, skipped: 2, failed: 2 });
  });

  it('skips the not-allowed, denied, not-open and not-pending refusals and fails an unknown code', async () => {
    const codes = [
      'category-proposal.not-allowed',
      'access.denied',
      'variant-request.not-open',
      'suggestion.not-pending',
      'something.else',
    ];
    const out = await runBulkDecide(
      codes.map((_, i) => ({ id: id(i), version: 1 })),
      (item) => Promise.resolve(err({ code: codes[Number(item.id.slice(-12))]! })),
    );
    expect(out.results.map((r) => r.outcome)).toEqual([
      'skipped',
      'skipped',
      'skipped',
      'skipped',
      'failed',
    ]);
  });
});
