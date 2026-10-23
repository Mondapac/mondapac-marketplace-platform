import { Logger } from '@nestjs/common';
import { testCallContext, testMarketContext } from '@mondapac/shared-kernel/testing';
import type { CertificationFacade } from '../../certification';
import type { EngagementFacade } from '../../engagement';
import { FacadePersonalSignals } from './facade-personal-signals';

// A refused or failed source is `null` (the caller fails closed) and is logged as a code or an
// error name with the Market and the correlation id only: never a message, a token or an id.

describe.each(['AU', 'ZZ'] as const)('FacadePersonalSignals, Market %s', (code) => {
  const context = testCallContext(testMarketContext(code, 'default'), 'anonymous', 'sig-abcdef-1');
  const privacy = { globalPrivacyControl: false, consent: true, guestToken: 'SECRET-TOKEN' };
  let warn: jest.SpyInstance;

  beforeEach(() => {
    warn = jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
  });
  afterEach(() => warn.mockRestore());

  const make = (engagement: unknown, certification: unknown) =>
    new FacadePersonalSignals(engagement as EngagementFacade, certification as CertificationFacade);

  it('logs the code of a refusal and answers null', async () => {
    const signals = make(
      { recentViews: () => Promise.resolve({ ok: false, error: { code: 'access.denied' } }) },
      {
        certifiedCategoryIds: () =>
          Promise.resolve({ ok: false, error: { code: 'certification.unavailable' } }),
      },
    );

    expect(await signals.recentViews(context, privacy)).toBeNull();
    expect(await signals.certifiedCategoryIds(context)).toBeNull();
    expect(warn.mock.calls.map((call: unknown[]) => call[0])).toEqual([
      {
        msg: 'search.signals-refused',
        source: 'engagement.recent-views',
        code: 'access.denied',
        marketId: code,
        correlationId: 'sig-abcdef-1',
      },
      {
        msg: 'search.signals-refused',
        source: 'certification.certified-categories',
        code: 'certification.unavailable',
        marketId: code,
        correlationId: 'sig-abcdef-1',
      },
    ]);
  });

  it('logs only the error name of a thrown error, never its message or the token', async () => {
    const boom = Object.assign(new TypeError('failed for SECRET-TOKEN'), {});
    const signals = make(
      { recentViews: () => Promise.reject(boom) },
      { certifiedCategoryIds: () => Promise.reject(boom) },
    );

    expect(await signals.recentViews(context, privacy)).toBeNull();
    expect(await signals.certifiedCategoryIds(context)).toBeNull();
    const logged = JSON.stringify(warn.mock.calls);
    expect(logged).toContain('TypeError');
    expect(logged).not.toContain('SECRET-TOKEN');
  });
});
