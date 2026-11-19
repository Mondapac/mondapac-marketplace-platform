import { Logger } from '@nestjs/common';
import { err, ok } from '@mondapac/shared-kernel';
import type { Id } from '@mondapac/shared-kernel';
import type { CertificationFacade } from '../../certification';
import {
  testAuthenticatedActor,
  testCallContext,
  testMarketContext,
} from '@mondapac/shared-kernel/testing';
import { CertificationCategoryRetirement } from './certification-category-retirement';

const IDS = ['01990000-0000-7000-8000-000000000c01' as Id<'Category'>];

const facade = (
  assert: () => Promise<unknown>,
  retired: () => Promise<unknown> = () => Promise.resolve(ok(undefined)),
  seen: unknown[] = [],
): CertificationFacade =>
  ({
    assertCategoriesRetirable: (context: unknown, ids: unknown) => {
      seen.push(context, ids);
      return assert();
    },
    platformCategoriesRetired: (context: unknown, ids: unknown) => {
      seen.push(context, ids);
      return retired();
    },
  }) as unknown as CertificationFacade;

describe.each(['AU', 'ZZ'] as const)('CertificationCategoryRetirement (%s)', (code) => {
  const market = testMarketContext(code, 'default');
  const context = testCallContext(
    market,
    testAuthenticatedActor(market, {
      population: 'admin',
      accountId: '01990000-0000-7000-8000-0000000000a1' as never,
      sessionId: '01990000-0000-7000-8000-0000000000a2' as never,
      sellerId: null,
    }),
  );
  let warn: jest.SpyInstance<void, [unknown, ...unknown[]]>;
  beforeEach(() => {
    warn = jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
  });
  afterEach(() => warn.mockRestore());

  describe('assertRetirable', () => {
    it('passes the caller context and ids unchanged, and an ok through', async () => {
      const seen: unknown[] = [];
      const adapter = new CertificationCategoryRetirement(
        facade(() => Promise.resolve(ok(undefined)), undefined, seen),
      );
      await expect(adapter.assertRetirable(context, IDS)).resolves.toEqual(ok(undefined));
      expect(seen).toEqual([context, IDS]);
      expect(warn).not.toHaveBeenCalled();
    });

    it('passes a well-formed referenced-by-policy refusal with its type codes', async () => {
      const adapter = new CertificationCategoryRetirement(
        facade(() =>
          Promise.resolve(
            err({ code: 'category.referenced-by-policy', typeCodes: ['halal', 'kosher-2'] }),
          ),
        ),
      );
      await expect(adapter.assertRetirable(context, IDS)).resolves.toEqual(
        err({ code: 'category.referenced-by-policy', typeCodes: ['halal', 'kosher-2'] }),
      );
    });

    it.each([
      ['a fault', () => Promise.reject(new Error('down'))],
      ['nothing', () => Promise.resolve(undefined)],
      ['a malformed answer', () => Promise.resolve({ ok: 'yes' })],
      ['another refusal', () => Promise.resolve(err({ code: 'validation.failed' }))],
      [
        'no type codes',
        () => Promise.resolve(err({ code: 'category.referenced-by-policy', typeCodes: [] })),
      ],
      [
        'type codes that are not a list',
        () => Promise.resolve(err({ code: 'category.referenced-by-policy', typeCodes: 'halal' })),
      ],
      [
        'a malformed type code',
        () =>
          Promise.resolve(err({ code: 'category.referenced-by-policy', typeCodes: ['Halal <b>'] })),
      ],
      [
        'a type code that is not a string',
        () => Promise.resolve(err({ code: 'category.referenced-by-policy', typeCodes: [7] })),
      ],
      [
        'more than 100 type codes',
        () =>
          Promise.resolve(
            err({
              code: 'category.referenced-by-policy',
              typeCodes: Array.from({ length: 101 }, (_v, n) => `type-${n}`),
            }),
          ),
      ],
    ])('reads %s as unavailable (fail closed) and logs no text', async (_case, answer) => {
      const adapter = new CertificationCategoryRetirement(facade(answer));
      await expect(adapter.assertRetirable(context, IDS)).resolves.toEqual(
        err({ code: 'category.check-unavailable' }),
      );
      expect(warn).toHaveBeenCalledTimes(1);
      expect(warn.mock.calls[0]![0]).toMatchObject({
        msg: 'catalog.category-retirement.unavailable',
        call: 'assert',
        marketId: code,
      });
      expect(JSON.stringify(warn.mock.calls)).not.toContain('down');
    });
  });

  describe('retired', () => {
    it('passes an ok through with the ids unchanged', async () => {
      const seen: unknown[] = [];
      const adapter = new CertificationCategoryRetirement(
        facade(
          () => Promise.resolve(ok(undefined)),
          () => Promise.resolve(ok(undefined)),
          seen,
        ),
      );
      await expect(adapter.retired(context, IDS)).resolves.toEqual(ok(undefined));
      expect(seen).toEqual([context, IDS]);
    });

    it.each([
      ['a fault', () => Promise.reject(new TypeError('boom'))],
      ['nothing', () => Promise.resolve(undefined)],
      ['a refusal', () => Promise.resolve(err({ code: 'access.denied' }))],
      ['a malformed answer', () => Promise.resolve({ ok: 1 })],
    ])('reads %s as unavailable, so the delivery is retried', async (_case, answer) => {
      const adapter = new CertificationCategoryRetirement(
        facade(() => Promise.resolve(ok(undefined)), answer),
      );
      await expect(adapter.retired(context, IDS)).resolves.toEqual(
        err({ code: 'category.check-unavailable' }),
      );
      expect(warn.mock.calls[0]![0]).toMatchObject({ call: 'retired', marketId: code });
    });
  });
});
