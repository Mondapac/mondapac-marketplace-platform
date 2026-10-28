import { ok, Temporal } from '@mondapac/shared-kernel';
import type { MarketContext, Result } from '@mondapac/shared-kernel';
import {
  FixedClock,
  SequenceIdGenerator,
  testCallContext,
  testMarketContext,
} from '@mondapac/shared-kernel/testing';
import { ConfigPaymentsPolicy } from '../../src/modules/payments/infrastructure/config-payments-policy';
import { StripeWebhookSignature } from '../../src/modules/payments/infrastructure/stripe-webhook-signature';
import type { PaymentsDependencies } from '../../src/modules/payments/application/payments-dependencies';
import type { PaymentsPolicy } from '../../src/modules/payments/application/ports/payments-policy';
import type { TransferSnapshot } from '../../src/modules/payments/application/ports/transfer-gateway';
import { AbandonTransfer } from '../../src/modules/payments/application/use-cases/abandon-transfer.use-case';
import { ApplyStripeEvents } from '../../src/modules/payments/application/use-cases/apply-stripe-events.use-case';
import { InstructTransfer } from '../../src/modules/payments/application/use-cases/instruct-transfer.use-case';
import { ReceiveStripeEvent } from '../../src/modules/payments/application/use-cases/receive-stripe-event.use-case';
import { ResolveTransfers } from '../../src/modules/payments/application/use-cases/resolve-transfers.use-case';
import { TransferByKeyQuery } from '../../src/modules/payments/application/use-cases/transfer-by-key.use-case';
import type { AccountSnapshot } from '../../src/modules/payments/domain/connected-account';
import { createUseCaseGate } from '../../src/platform/authz/use-case-gate';
import { loadMarketConfigs } from '../../src/platform/market-config/market-config';
import { MarketRegistry } from '../../src/platform/market-config/market-registry';
import type { UnitOfWorkOptions } from '../../src/platform/unit-of-work/unit-of-work';
import {
  FakeConnectGateway,
  FakeDisputeReader,
  FakeIdentityFacade,
  FakeOrderingFacade,
  FakeSessionReader,
  FakeTransferGateway,
  MemoryAccountStore,
  MemoryDisputeStore,
  MemoryInbox,
  MemoryTransferStore,
  RecordingPaymentsAudit,
  RecordingPaymentsOutbox,
  stripeSignatureHeader,
  TEST_WEBHOOK_SECRET,
  testKeyring,
} from './payments-fakes';
import { FakeUnitOfWork } from './pricing-fakes';
import { RecordingSecurityEvents } from './recording-security-events';
import { TEST_MARKET_CONFIG_DIRS, TEST_MARKET_IDS } from './test-config';

// The transfer execution (package 6c) on both Market fixtures, in memory: one place that builds the
// dependencies and the use cases, seeds a connected account that is ready to be paid, and tracks
// whether a call to Stripe was made inside a unit of work (it must never be).

export const markets = new MarketRegistry(
  loadMarketConfigs(TEST_MARKET_CONFIG_DIRS, TEST_MARKET_IDS),
);
export const T0 = Temporal.Instant.from('2026-10-27T10:00:00Z');
export const SELLER = '01990000-0000-7000-8000-0000000000b1';
export const OTHER_SELLER = '01990000-0000-7000-8000-0000000000b2';
export const PAYOUT = '01990000-0000-7000-8000-0000000000e1';
export const OTHER_PAYOUT = '01990000-0000-7000-8000-0000000000e2';
export const ACCOUNT = 'acct_test_0001';
export const EXTERNAL = 'ba_test_default';
export const KEY = 'payout-0001';
export const AMOUNT = 5000n;

/** What each Market fixture says: its currency, ceiling, alert threshold, lease and time zone. */
export const MARKET_FACTS = {
  AU: {
    currency: 'AUD',
    other: 'NZD',
    max: 500_000n,
    threshold: 2_000_000n,
    leaseSeconds: 120,
    zone: 'Australia/Brisbane',
  },
  ZZ: {
    currency: 'JPY',
    other: 'AUD',
    max: 800_000n,
    threshold: 3_000_000n,
    leaseSeconds: 90,
    zone: 'Asia/Tokyo',
  },
} as const;
export type MarketCode = keyof typeof MARKET_FACTS;

/** A unit of work that counts how deep it is, so a spec can tell a call made outside any unit. */
export class TrackingUnitOfWork extends FakeUnitOfWork {
  depth = 0;
  override run<T, E>(
    market: MarketContext,
    work: () => Promise<Result<T, E>>,
    options?: UnitOfWorkOptions,
  ): Promise<Result<T, E>> {
    this.depth += 1;
    return super.run(market, work, options).finally(() => {
      this.depth -= 1;
    });
  }
}

export function buildTransferHarness(
  code: MarketCode,
  policyOf?: (real: PaymentsPolicy) => PaymentsPolicy,
) {
  const facts = MARKET_FACTS[code];
  const market = testMarketContext(code, 'default');
  const system = testCallContext(market, 'system', 'trf-0001-abcd');
  const anonymous = testCallContext(market, 'anonymous', 'trf-0002-abcd');
  const gate = createUseCaseGate(markets, { check: () => Promise.resolve({ allowed: true }) });
  const clock = new FixedClock(T0);
  const units = new TrackingUnitOfWork();
  const accounts = new MemoryAccountStore();
  const transfers = new MemoryTransferStore();
  const transferGateway = new FakeTransferGateway();
  const connect = new FakeConnectGateway();
  const inbox = new MemoryInbox();
  const outbox = new RecordingPaymentsOutbox();
  const audit = new RecordingPaymentsAudit();
  const securityEvents = new RecordingSecurityEvents();
  const realPolicy = new ConfigPaymentsPolicy(markets);
  /** Where Stripe was called from: the unit depth at each call. */
  const depthAtCall: { call: string; depth: number }[] = [];
  const readAccount = connect.readAccount.bind(connect);
  connect.readAccount = (ref: string) => {
    depthAtCall.push({ call: 'readAccount', depth: units.depth });
    return readAccount(ref);
  };
  for (const name of ['createTransfer', 'listTransfersByGroup', 'readTransfer'] as const) {
    const original = transferGateway[name].bind(transferGateway) as (...args: unknown[]) => unknown;
    (transferGateway as unknown as Record<string, unknown>)[name] = (...args: unknown[]) => {
      depthAtCall.push({ call: name, depth: units.depth });
      return original(...args);
    };
  }
  const deps: PaymentsDependencies = {
    unitOfWork: units,
    inbox,
    signature: new StripeWebhookSignature({ [code]: TEST_WEBHOOK_SECRET }, clock),
    reader: new FakeSessionReader(),
    disputeReader: new FakeDisputeReader(),
    disputes: new MemoryDisputeStore(),
    outbox,
    ordering: new FakeOrderingFacade(),
    accounts,
    connect,
    transfers,
    transferGateway,
    keyring: testKeyring(),
    policy: policyOf === undefined ? realPolicy : policyOf(realPolicy),
    identity: new FakeIdentityFacade(),
    audit,
    securityEvents,
    ids: new SequenceIdGenerator(clock),
    clock,
  };
  const useCases = {
    instruct: new InstructTransfer(gate, deps),
    byKey: new TransferByKeyQuery(gate, deps),
    abandon: new AbandonTransfer(gate, deps),
    resolve: new ResolveTransfers(gate, deps),
    apply: new ApplyStripeEvents(gate, deps),
    receive: new ReceiveStripeEvent(gate, deps),
  };

  const hmacOf = (providerId: string, version = 1): string =>
    testKeyring().hmac(version, providerId)!;
  const accountKey = `${code}/${SELLER}`;
  /** A connected account that is ready to be paid and stamped with the hash of `EXTERNAL`. */
  const seedAccount = async (
    fields: Partial<NonNullable<ReturnType<MemoryAccountStore['rows']['get']>>> = {},
    sellerId = SELLER,
  ): Promise<void> => {
    await accounts.insert(market, sellerId, T0.subtract({ hours: 100 }));
    await accounts.linkRef(market, sellerId, ACCOUNT);
    const key = `${code}/${sellerId}`;
    accounts.rows.set(key, {
      ...accounts.rows.get(key)!,
      status: 'enabled',
      detailsSubmitted: true,
      transfersActive: true,
      payoutsEnabled: true,
      lastReadAt: T0.subtract({ hours: 1 }),
      lastChangeId: '01990000-0000-7000-8000-0000000000c0',
      externalAccountHmac: hmacOf(EXTERNAL),
      ...fields,
    });
  };
  const accountSnapshot = (fields: Partial<AccountSnapshot> = {}): AccountSnapshot => ({
    id: ACCOUNT,
    metadataMarketId: code,
    metadataSellerId: SELLER,
    detailsSubmitted: true,
    transfersActive: true,
    payoutsEnabled: true,
    requirementsDue: 0,
    requirementsPastDue: false,
    disabledReason: null,
    payoutScheduleInterval: 'manual',
    externalAccountCount: 1,
    defaultExternalAccountId: EXTERNAL,
    ...fields,
  });
  /** Stripe's transfer for the standard request (override any field). */
  const stripeTransfer = (fields: Partial<TransferSnapshot> = {}): TransferSnapshot => ({
    id: 'tr_test_0001',
    livemode: false,
    amountMinor: AMOUNT,
    currency: facts.currency.toLowerCase(),
    destination: ACCOUNT,
    amountReversedMinor: 0n,
    key: KEY,
    marketId: code,
    ...fields,
  });
  const request = (fields: Record<string, unknown> = {}) => ({
    instructionKey: KEY,
    sellerId: SELLER,
    amount: { amount: AMOUNT, currency: facts.currency },
    reference: PAYOUT,
    ...fields,
  });
  const ready = async (): Promise<void> => {
    await seedAccount();
    connect.readAnswer = ok(accountSnapshot());
  };
  /** The ready account, an instruct that Stripe never answers: a row left `sending`. */
  const leaveSending = async (): Promise<void> => {
    await ready();
    transferGateway.createAnswer = { kind: 'unknown' };
    await useCases.instruct.execute(system, request());
    transferGateway.createAnswer = { kind: 'created', ref: 'tr_test_0001' };
  };
  const deliver = (event: Record<string, unknown>) => {
    const body = Buffer.from(JSON.stringify(event));
    return useCases.receive.execute(anonymous, {
      payload: body,
      signature: stripeSignatureHeader(body, clock.now()),
    });
  };
  const alerts = () =>
    securityEvents.events.filter((e) => e.type === 'payments.transfer.alert').map((e) => e.payload);
  const liveCheckFailures = () =>
    securityEvents.events.filter((e) => e.type === 'payments.live-check.failed');
  const row = (key = KEY) => transfers.rows.get(`${code}/${key}`);

  return {
    code,
    facts,
    market,
    system,
    anonymous,
    gate,
    clock,
    units,
    deps,
    accounts,
    transfers,
    transferGateway,
    connect,
    inbox,
    outbox,
    audit,
    securityEvents,
    depthAtCall,
    useCases,
    hmacOf,
    accountKey,
    seedAccount,
    accountSnapshot,
    stripeTransfer,
    request,
    ready,
    leaveSending,
    deliver,
    alerts,
    liveCheckFailures,
    row,
  };
}

/** A transfer event body, as the platform endpoint receives it. */
export function transferEvent(fields: {
  readonly id?: string;
  readonly type?: string;
  readonly transferId?: string;
  readonly livemode?: boolean;
  readonly account?: string;
  readonly marketId?: string | null;
}): Record<string, unknown> {
  return {
    id: fields.id ?? 'evt_test_tr_0001',
    object: 'event',
    type: fields.type ?? 'transfer.created',
    livemode: fields.livemode ?? false,
    ...(fields.account === undefined ? {} : { account: fields.account }),
    data: {
      object: {
        id: fields.transferId ?? 'tr_test_0001',
        object: 'transfer',
        amount: 5000,
        metadata: fields.marketId === null ? {} : { market_id: fields.marketId ?? 'AU' },
      },
    },
  };
}
