import { Temporal } from '@mondapac/shared-kernel';
import type { Id } from '@mondapac/shared-kernel';
import {
  FixedClock,
  SequenceIdGenerator,
  testCallContext,
  testMarketContext,
} from '@mondapac/shared-kernel/testing';
import { RecordingReevaluationRequests } from '../../../../../test/support/catalog-tag-fakes';
import { fakeRunOnce } from '../../../../../test/support/fake-run-once';
import { TEST_MARKET_CONFIG_DIRS, TEST_MARKET_IDS } from '../../../../../test/support/test-config';
import type { AuthorisationCheck } from '../../../../platform/authz';
import { createUseCaseGate } from '../../../../platform/authz/use-case-gate';
import type { EventDelivery } from '../../../../platform/events/event-delivery';
import { loadMarketConfigs } from '../../../../platform/market-config/market-config';
import { MarketRegistry } from '../../../../platform/market-config/market-registry';
import type { UnitOfWork } from '../../../../platform/unit-of-work/unit-of-work';
import {
  CERTIFICATION_CAUSES,
  ENDING_CAUSES,
  TYPE_CAUSES,
} from '../ports/tag-reevaluation-requests';
import { ReevaluateFromCertification } from './reevaluate-from-certification.use-case';
import { selectionOf } from './reevaluate-tags.use-case';

// The handler of catalog's certification subscriptions without a database (catalog design 5.5;
// certification slice 14): a coverage change writes the recheck of the certificate's own tags and
// the type request in one handler unit, and skips the type request an identical pending one no
// run has started already covers (Hassan M2); the ending and the type causes never overlap, so
// the pre-marking of every run never needs a type code (Hassan L2). The same requests over the
// real tables: test/db/catalog-cert-reevaluation.db-spec.ts.

const markets = new MarketRegistry(loadMarketConfigs(TEST_MARKET_CONFIG_DIRS, TEST_MARKET_IDS));
const admitAll: AuthorisationCheck = { check: () => Promise.resolve({ allowed: true }) };
const gate = createUseCaseGate(markets, admitAll);
const T0 = Temporal.Instant.from('2026-10-18T00:00:00Z');
/** When the consumed events occurred, in these tests. */
const OCCURRED = Temporal.Instant.from('2026-10-17T23:00:00Z');
const AFTER = OCCURRED.add({ seconds: 1 });
const BEFORE = OCCURRED.subtract({ seconds: 1 });
const TYPE = '0192b3c4-0000-7000-8000-0000000000a1' as Id;
const CERTIFICATE = '0192b3c4-0000-7000-8000-0000000000b1' as Id;

describe('certification causes (Hassan L2)', () => {
  it('never lists a type cause as an ending cause: the pre-marking selects without a type code', () => {
    const ending = new Set<string>(ENDING_CAUSES);
    expect(TYPE_CAUSES.filter((cause) => ending.has(cause))).toEqual([]);
    for (const cause of ENDING_CAUSES) {
      expect(selectionOf(cause, CERTIFICATE)).toEqual({
        selection: { by: 'certificate', id: CERTIFICATE },
        markFirst: true,
      });
    }
    for (const cause of TYPE_CAUSES) {
      expect(() => selectionOf(cause, TYPE)).toThrow('needs the type code');
    }
    // Every cause is one or the other kind of selection, or neither: none is unhandled.
    for (const cause of CERTIFICATION_CAUSES) {
      expect(() => selectionOf(cause, TYPE, 'halal')).not.toThrow();
    }
  });
});

describe.each(['AU', 'ZZ'] as const)(
  'catalog.reevaluate-from-certification in market %s',
  (code) => {
    const market = testMarketContext(code, 'default');
    const system = () => testCallContext(market, 'system');
    let n = 0;
    const delivery = (subscriber: string): EventDelivery => {
      n += 1;
      return {
        eventId: `0192b3c4-0000-7000-8000-${n.toString(16).padStart(12, '0')}` as Id<'event'>,
        subscriber,
        attempt: 1,
      };
    };

    function rig() {
      const requests = new RecordingReevaluationRequests();
      const clock = new FixedClock(T0);
      const unitOfWork = { runOnce: fakeRunOnce() } as unknown as UnitOfWork;
      const handler = new ReevaluateFromCertification(gate, {
        unitOfWork,
        requests,
        ids: new SequenceIdGenerator(clock),
        clock,
      });
      return { requests, handler };
    }

    it('writes the certificate recheck and the type request of a coverage change in one unit (Hassan M2)', async () => {
      const { requests, handler } = rig();
      const d = delivery('catalog.reevaluate-on-product-certification-coverage-changed');
      const result = await handler.execute(system(), {
        delivery: d,
        occurredAt: OCCURRED,
        cause: 'product-certification-coverage-changed',
        subjectId: TYPE,
        recheckCertificateId: CERTIFICATE,
      });
      expect(result).toEqual({ ok: true, value: { code: 'catalog.reevaluation-requested' } });
      expect(requests.events).toEqual([
        {
          cause: 'product-certification-coverage-recheck',
          subjectId: CERTIFICATE,
          sourceEventId: d.eventId,
        },
        {
          cause: 'product-certification-coverage-changed',
          subjectId: TYPE,
          sourceEventId: d.eventId,
        },
      ]);
      // A repeat of the delivery stops at the inbox: nothing more is written.
      expect(
        await handler.execute(system(), {
          delivery: d,
          occurredAt: OCCURRED,
          cause: 'product-certification-coverage-changed',
          subjectId: TYPE,
          recheckCertificateId: CERTIFICATE,
        }),
      ).toEqual({ ok: true, value: { code: 'catalog.reevaluation.already-handled' } });
      expect(requests.events).toHaveLength(2);
    });

    it('skips a type request an identical unstarted pending one written after the event covers, never the recheck', async () => {
      const { requests, handler } = rig();
      requests.unstarted.set(`product-certification-coverage-changed:${TYPE}`, AFTER);
      requests.unstarted.set(`claim-policy-changed:${TYPE}`, AFTER);
      const coverage = delivery('catalog.reevaluate-on-product-certification-coverage-changed');
      await handler.execute(system(), {
        delivery: coverage,
        occurredAt: OCCURRED,
        cause: 'product-certification-coverage-changed',
        subjectId: TYPE,
        recheckCertificateId: CERTIFICATE,
      });
      await handler.execute(system(), {
        delivery: delivery('catalog.reevaluate-on-claim-policy-changed'),
        occurredAt: OCCURRED,
        cause: 'claim-policy-changed',
        subjectId: TYPE,
      });
      // Another cause of the same type is not identical: it is written.
      await handler.execute(system(), {
        delivery: delivery('catalog.reevaluate-on-product-certification-approved'),
        occurredAt: OCCURRED,
        cause: 'product-certification-approved',
        subjectId: TYPE,
      });
      expect(requests.events.map((e) => [e.cause, e.subjectId])).toEqual([
        ['product-certification-coverage-recheck', CERTIFICATE],
        ['product-certification-approved', TYPE],
      ]);
    });

    it.each([
      ['before the event', BEFORE],
      ['at the instant of the event', OCCURRED],
    ])(
      'writes the type request when the identical pending one was written %s: a run may already ask its first page from the older state (Hassan N1)',
      async (_label, createdAt) => {
        const { requests, handler } = rig();
        requests.unstarted.set(`product-certification-coverage-changed:${TYPE}`, createdAt);
        await handler.execute(system(), {
          delivery: delivery('catalog.reevaluate-on-product-certification-coverage-changed'),
          occurredAt: OCCURRED,
          cause: 'product-certification-coverage-changed',
          subjectId: TYPE,
          recheckCertificateId: CERTIFICATE,
        });
        expect(requests.events.map((e) => [e.cause, e.subjectId])).toEqual([
          ['product-certification-coverage-recheck', CERTIFICATE],
          ['product-certification-coverage-changed', TYPE],
        ]);
      },
    );

    it('never skips a seller-certificate request, whatever is pending', async () => {
      const { requests, handler } = rig();
      requests.unstarted.set(`seller-certification-revoked:${CERTIFICATE}`, AFTER);
      await handler.execute(system(), {
        delivery: delivery('catalog.reevaluate-on-seller-certification-revoked'),
        occurredAt: OCCURRED,
        cause: 'seller-certification-revoked',
        subjectId: CERTIFICATE,
      });
      expect(requests.events.map((e) => e.cause)).toEqual(['seller-certification-revoked']);
    });
  },
);
