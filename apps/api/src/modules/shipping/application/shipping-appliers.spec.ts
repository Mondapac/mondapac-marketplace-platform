import { InMemoryAuditTrail } from '../../../../test/support/change-trail-fakes';
import { err, parseId, Temporal } from '@mondapac/shared-kernel';
import type { AuditEntry, CallContext, Id } from '@mondapac/shared-kernel';
import {
  FixedClock,
  SequenceIdGenerator,
  testAuthenticatedActor,
  testCallContext,
  testMarketContext,
} from '@mondapac/shared-kernel/testing';
import { FakeUnitOfWork } from '../../../../test/support/pricing-fakes';
import { RecordingProposer, RecordingReview } from '../../../../test/support/system-request-fakes';
import { ListRegistry, MemorySelection } from '../../../../test/support/shipping-fakes';
import { TEST_MARKET_CONFIG_DIRS, TEST_MARKET_IDS } from '../../../../test/support/test-config';
import type { AuditWriter } from '../../../platform/audit/audit-writer';
import type { AccessDeclaration, AuthorisationCheck } from '../../../platform/authz';
import { createUseCaseGate } from '../../../platform/authz/use-case-gate';
import { loadMarketConfigs } from '../../../platform/market-config/market-config';
import { MarketRegistry } from '../../../platform/market-config/market-registry';
import type { ChangeValues } from '../../system-requests';
import { SHIPPING_FLEET_SELECTION_MANAGE } from '../contracts/permissions';
import { SHIPPING_AUDIT_ACTIONS } from '../domain/audit';
import { SHIPPING_APPLIER_PERMISSIONS } from '../shipping.module';
import { FleetModelCreateApplier } from './shipping-appliers';
import type { ShippingApplierDependencies } from './shipping-dependencies';
import { FLEET_MODEL_CREATE_SUBJECT_KIND, fleetModelNameRef } from './shipping-review';
import { CreateFleetSelectionModel } from './use-cases/create-fleet-selection-model.use-case';

// The create of a fleet-selection model in approval mode (Admin Inbox › System requests, owner
// decision of 18 Nov 2026, "mixed"), in memory on both Market fixtures: where the Market does not
// review area delivery the model is created at once; where it does, the create files a proposal
// and writes nothing in shipping, and the applier creates the model on approval, as the approving
// admin, naming the request in the audit row.

const markets = new MarketRegistry(loadMarketConfigs(TEST_MARKET_CONFIG_DIRS, TEST_MARKET_IDS));
const T0 = Temporal.Instant.from('2026-11-18T10:00:00Z');
const id = <T extends string>(n: number): Id<T> => {
  const parsed = parseId(`01990000-0000-7000-8000-${n.toString(16).padStart(12, '0')}`);
  if (!parsed.ok) throw new Error('bad id');
  return parsed.value as Id<T>;
};

class RecordingAudit extends InMemoryAuditTrail implements AuditWriter {
  override record(context: CallContext, entry: AuditEntry): Promise<void> {
    if (!SHIPPING_AUDIT_ACTIONS.some((definition) => definition.action === entry.action)) {
      throw new Error(`audit: unknown action ${entry.action}`);
    }
    return super.record(context, entry);
  }
}

describe('the approval kind of a new model', () => {
  it('is registered with every key of the create route', () => {
    expect(FLEET_MODEL_CREATE_SUBJECT_KIND).toBe('shipping.fleet-selection-model-create');
    expect(Object.fromEntries(SHIPPING_APPLIER_PERMISSIONS)).toEqual({
      'shipping.fleet-selection-model-create': [SHIPPING_FLEET_SELECTION_MANAGE.key],
    });
    expect(CreateFleetSelectionModel.access.rule).toEqual({
      kind: 'permissions',
      allOf: [SHIPPING_FLEET_SELECTION_MANAGE.key],
    });
  });

  it('names the subject by the name as the Market compares names, within a subject ref', () => {
    const ref = /^[A-Za-z0-9][A-Za-z0-9._:-]*$/;
    expect(fleetModelNameRef('Cheapest wins')).toBe('name:cheapest_20.wins');
    expect(fleetModelNameRef('  CHEAPEST Wins ')).toBe(fleetModelNameRef('cheapest wins'));
    // Exact: names that differ only by a space or a hyphen are different subjects.
    expect(fleetModelNameRef('a b')).not.toBe(fleetModelNameRef('a-b'));
    expect(fleetModelNameRef('a_20.b')).not.toBe(fleetModelNameRef('a b'));
    const persian = 'مدل ارزان‌ترین تحویل سریع برای شهر بزرگ با اولویت ناوگان خودمان';
    const long = fleetModelNameRef(persian.slice(0, 60));
    expect(long).toMatch(/^name-sha256:[0-9a-f]{64}$/);
    for (const name of ['Cheapest wins', 'ÉTÉ (fast)', persian.slice(0, 60), 'x'.repeat(60)]) {
      const subject = fleetModelNameRef(name);
      expect(subject).toMatch(ref);
      expect(subject.length).toBeLessThanOrEqual(128);
    }
  });
});

describe.each([['AU'], ['ZZ']] as const)(
  'a new model waiting for approval in market %s',
  (code) => {
    const market = testMarketContext(code, 'default');
    const gate = createUseCaseGate(markets, { check: () => Promise.resolve({ allowed: true }) });
    const adminOf = (accountId: Id<'Account'>, name: string): CallContext =>
      testCallContext(
        market,
        testAuthenticatedActor(market, {
          population: 'admin',
          accountId,
          sessionId: id<'Session'>(0x61),
          sellerId: null,
        }),
        name,
      );
    const author = adminOf(id<'Account'>(0xad), 'fleet-author-abcd');
    const approver = adminOf(id<'Account'>(0xae), 'fleet-approver-abcd');
    const requestId = id<'SystemRequest'>(0xe1);

    let selection: MemorySelection;
    let audit: RecordingAudit;
    let review: RecordingReview;
    let proposer: RecordingProposer;
    let allowed: boolean | 'throws';
    let asked: AccessDeclaration[];
    let deps: ShippingApplierDependencies & { readonly proposer: RecordingProposer };

    beforeEach(() => {
      selection = new MemorySelection();
      const clock = new FixedClock(T0);
      audit = new RecordingAudit(clock);
      review = new RecordingReview();
      proposer = new RecordingProposer(review);
      allowed = true;
      asked = [];
      const authorisation: AuthorisationCheck = {
        check: (_context, declaration) => {
          asked.push(declaration);
          if (allowed === 'throws') return Promise.reject(new Error('identity unavailable'));
          return Promise.resolve(
            allowed ? { allowed: true } : { allowed: false, denial: { code: 'access.denied' } },
          );
        },
      };
      deps = {
        unitOfWork: new FakeUnitOfWork(),
        policy: undefined as never,
        sellers: undefined as never,
        audit,
        review,
        proposer,
        authorisation,
        clock,
        ids: new SequenceIdGenerator(clock),
        outbox: undefined as never,
        bookings: undefined as never,
        fleets: new ListRegistry([]),
        selection,
        deliverySettings: undefined as never,
        carrierPolicy: undefined as never,
        quotes: undefined as never,
        ledger: undefined as never,
        pickups: undefined as never,
        webhookSignature: undefined as never,
        uberWebhookSignature: undefined as never,
        securityEvents: undefined as never,
        trail: undefined as never,
      };
    });

    const create = (input: Record<string, unknown>, context: CallContext = author) =>
      new CreateFleetSelectionModel(gate, deps).execute(context, input as never);
    const WEIGHTED = { kind: 'weighted', weights: { price: 20, eta: 70, reliability: 10 } };

    it('creates the model at once where the Market does not review delivery (no note needed)', async () => {
      const created = await create({ name: 'Speed first', rule: WEIGHTED });
      expect(created).toMatchObject({ ok: true, value: { name: 'Speed first', version: 1 } });
      expect(proposer.proposed).toHaveLength(0);
      expect(selection.models.size).toBe(1);
      expect(audit.entries).toHaveLength(1);
      expect(audit.entries[0]).toMatchObject({
        action: 'shipping.fleet-model.created',
        after: { kind: 'weighted', version: 1, requestId: null },
      });
    });

    it('files a proposal and writes nothing in shipping where the Market reviews delivery', async () => {
      review.review('delivery', 'medium');
      const proposed = await create({
        name: '  Speed first ',
        rule: WEIGHTED,
        note: 'Faster cars',
      });
      // Only the proposal: nothing else is answered.
      expect(proposed.ok && Object.keys(proposed.value)).toEqual(['request']);
      expect(proposed.ok && proposed.value).toMatchObject({ request: { number: 901 } });
      expect(proposer.proposed).toEqual([
        {
          area: 'delivery',
          subjectKind: 'shipping.fleet-selection-model-create',
          subjectRef: fleetModelNameRef('Speed first'),
          before: { exists: false },
          after: { action: 'create', name: 'Speed first', rule: WEIGHTED },
          note: 'Faster cars',
        },
      ]);
      expect(selection.models.size).toBe(0);
      expect(audit.entries).toHaveLength(0);
    });

    it('refuses a reviewed create without a note, and a name already taken, filing nothing', async () => {
      const existing = await create({ name: 'Cheapest wins', rule: { kind: 'cheapest' } });
      expect(existing.ok).toBe(true);
      review.review('delivery');
      expect(await create({ name: 'Speed first', rule: WEIGHTED })).toEqual(
        err({ code: 'validation.failed', fields: [{ path: 'note', code: 'required' }] }),
      );
      expect(await create({ name: 'CHEAPEST wins', rule: WEIGHTED, note: 'Again' })).toEqual(
        err({ code: 'shipping.fleet-model-name-taken' }),
      );
      expect(await create({ name: '', rule: WEIGHTED, note: 'Bad' })).toEqual(
        err({ code: 'validation.failed', fields: [{ path: 'name', code: 'format' }] }),
      );
      expect(proposer.proposed).toHaveLength(0);
      expect(selection.models.size).toBe(1);
    });

    it('refuses a second proposal of the same name (any case) while the first waits', async () => {
      review.review('delivery');
      expect((await create({ name: 'Speed first', rule: WEIGHTED, note: 'One' })).ok).toBe(true);
      expect(
        await create({ name: 'SPEED FIRST', rule: { kind: 'cheapest' }, note: 'Two' }),
      ).toEqual(err({ code: 'system-requests.already-pending', pendingNumber: 901 }));
      expect(proposer.proposed).toHaveLength(1);
      expect(selection.models.size).toBe(0);
    });

    it('refuses a caller without the key before anything is filed', async () => {
      review.review('delivery');
      const denying = createUseCaseGate(markets, {
        check: () =>
          Promise.resolve({ allowed: false, denial: { code: 'access.denied' } as const }),
      });
      const result = await new CreateFleetSelectionModel(denying, deps).execute(author, {
        name: 'Speed first',
        rule: WEIGHTED,
        note: 'x',
      });
      expect(result).toMatchObject({ ok: false, error: { code: 'access.denied' } });
      expect(proposer.proposed).toHaveLength(0);
    });

    describe('the applier', () => {
      const applier = () => new FleetModelCreateApplier(deps);
      const proposal = (after: ChangeValues, subjectRef = fleetModelNameRef('Speed first')) => ({
        requestId,
        subjectRef,
        before: { exists: false },
        after,
      });
      const SPEED = { action: 'create', name: 'Speed first', rule: WEIGHTED };

      it('checks that the approver holds the create key, through the authorisation port', async () => {
        expect(await applier().check(approver, proposal(SPEED))).toBe('ok');
        expect(asked).toEqual([CreateFleetSelectionModel.access]);
        allowed = false;
        expect(await applier().check(approver, proposal(SPEED))).toBe('not-permitted');
        allowed = 'throws';
        expect(await applier().check(approver, proposal(SPEED))).toBe('not-permitted');
      });

      it('fails closed on values that no longer validate and on a caller who is not an admin', async () => {
        const bad = { action: 'create', name: 'Speed first', rule: { kind: 'fastest' } };
        expect(await applier().check(approver, proposal(bad))).toBe('not-permitted');
        expect(await applier().check(approver, proposal({ action: 'delete' }))).toBe(
          'not-permitted',
        );
        const seller = testCallContext(
          market,
          testAuthenticatedActor(market, {
            population: 'seller',
            accountId: id<'Account'>(0xa1),
            sessionId: id<'Session'>(0x62),
            sellerId: id<'Seller'>(0x51),
          }),
          'fleet-seller-abcd',
        );
        expect(await applier().check(seller, proposal(SPEED))).toBe('not-permitted');
        expect(selection.models.size).toBe(0);
      });

      it('creates the model on approval and audits it with the request id', async () => {
        review.review('delivery');
        const proposed = await create({ name: 'Speed first', rule: WEIGHTED, note: 'Faster cars' });
        expect(proposed.ok).toBe(true);
        const filed = proposer.proposed[0]!;
        const request = {
          requestId,
          subjectRef: filed.subjectRef,
          before: filed.before,
          after: filed.after,
        };
        expect(await applier().check(approver, request)).toBe('ok');
        expect(await applier().apply(approver, request)).toBe('applied');
        const models = [...selection.models.values()];
        expect(models).toHaveLength(1);
        expect(models[0]).toMatchObject({ name: 'Speed first', rule: WEIGHTED, version: 1 });
        expect(audit.entries).toHaveLength(1);
        expect(audit.entries[0]).toMatchObject({
          action: 'shipping.fleet-model.created',
          targetId: models[0]!.id,
          after: { kind: 'weighted', version: 1, weightEta: 70, requestId },
        });
        expect(JSON.stringify(audit.entries)).not.toContain('Speed first');
        // A second approval finds the name taken: changed-since, nothing more is written.
        expect(await applier().apply(approver, request)).toBe('changed-since');
        expect(selection.models.size).toBe(1);
        expect(audit.entries).toHaveLength(1);
      });

      it('answers changed-since when another model took the name meanwhile (any case)', async () => {
        expect((await create({ name: 'speed FIRST', rule: { kind: 'cheapest' } })).ok).toBe(true);
        audit.entries.length = 0;
        expect(await applier().apply(approver, proposal(SPEED))).toBe('changed-since');
        expect(selection.models.size).toBe(1);
        expect(audit.entries).toHaveLength(0);
      });

      it('answers gone for values that are not a proposed model of this subject', async () => {
        expect(await applier().apply(approver, proposal({ action: 'delete' }))).toBe('gone');
        expect(
          await applier().apply(approver, proposal(SPEED, fleetModelNameRef('Another name'))),
        ).toBe('gone');
        expect(
          await applier().apply(approver, { ...proposal(SPEED), before: { exists: true } }),
        ).toBe('gone');
        expect(await applier().apply(approver, proposal({ ...SPEED, extra: 'field' }))).toBe(
          'gone',
        );
        expect(selection.models.size).toBe(0);
      });

      it('keeps the models of each Market apart: a name taken in another Market is free here', async () => {
        const other = testMarketContext(code === 'AU' ? 'ZZ' : 'AU', 'default');
        await selection.insertModel(other, {
          id: id<'FleetSelectionModel'>(0x77),
          name: 'Speed first',
          rule: { kind: 'cheapest' },
          version: 1,
          createdAt: T0,
          updatedAt: T0,
        });
        expect(await applier().apply(approver, proposal(SPEED))).toBe('applied');
        expect((await selection.listModels(market)).map((model) => model.name)).toEqual([
          'Speed first',
        ]);
      });
    });
  },
);
