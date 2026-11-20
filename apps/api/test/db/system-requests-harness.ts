import { devNull } from 'node:os';
import type { INestApplicationContext } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { Client } from 'pg';
import pino from 'pino';
import { err, ok, Temporal } from '@mondapac/shared-kernel';
import type { CallContext, Id, MarketContext, Result } from '@mondapac/shared-kernel';
import {
  FixedClock,
  testAuthenticatedActor,
  testCallContext,
} from '@mondapac/shared-kernel/testing';
import { AppModule } from '../../src/app.module';
import {
  createFleetSelectionModel,
  updateFleetSelectionModel,
} from '../../src/modules/shipping/application/fleet-selection-flow';
import { FleetModelCreateApplier } from '../../src/modules/shipping/application/shipping-appliers';
import type {
  FleetModelCreateDependencies,
  ShippingApplierDependencies,
} from '../../src/modules/shipping/application/shipping-dependencies';
import { FleetSelectionModelReverter } from '../../src/modules/shipping/application/shipping-reverters';
import {
  FLEET_MODEL_CREATE_SUBJECT_KIND,
  FLEET_MODEL_SUBJECT_KIND,
} from '../../src/modules/shipping/application/shipping-review';
import { ConfigCarrierPolicy } from '../../src/modules/shipping/infrastructure/config-carrier-policy';
import { ConfigShippingPolicy } from '../../src/modules/shipping/infrastructure/config-shipping-policy';
import { PrismaFleetSelectionRepository } from '../../src/modules/shipping/infrastructure/prisma-fleet-selection.repository';
import {
  SHIPPING_APPLIER_PERMISSIONS,
  ShippingModule,
} from '../../src/modules/shipping/shipping.module';
import {
  SYSTEM_ACTION_PROPOSER,
  SYSTEM_REQUEST_RECORDER,
  SystemRequestOverdue,
  SystemRequestsModule,
  type SystemActionProposer,
  type SystemChangeApplier,
  type SystemChangeReverter,
  type SystemRequestRecorder,
} from '../../src/modules/system-requests';
import {
  POLICY_REPOSITORY,
  type PolicyRepository,
} from '../../src/modules/system-requests/application/ports/policy.repository';
import {
  REQUEST_REPOSITORY,
  type RequestRepository,
} from '../../src/modules/system-requests/application/ports/request.repository';
import { ImpactCache } from '../../src/modules/system-requests/application/impact-cache';
import { ReverterRegistry } from '../../src/modules/system-requests/application/reverter-registry';
import type { SystemRequestsDependencies } from '../../src/modules/system-requests/application/system-requests-dependencies';
import { AUDIT_WRITER, type AuditWriter } from '../../src/platform/audit/audit-writer';
import type { AuthorisationCheck, ConsumedStepUp, StepUpRefusal } from '../../src/platform/authz';
import { CLOCK } from '../../src/platform/clock/clock.module';
import { OUTBOX_WRITER, type OutboxWriter } from '../../src/platform/events/outbox-writer';
import { UuidV7IdGenerator } from '../../src/platform/ids/uuid-v7-id-generator';
import { loadMarketConfigs } from '../../src/platform/market-config/market-config';
import { MarketRegistry } from '../../src/platform/market-config/market-registry';
import { loadServiceAreas } from '../../src/platform/market-config/service-area-config';
import { PrismaService } from '../../src/platform/persistence/prisma.service';
import { UNIT_OF_WORK, type UnitOfWork } from '../../src/platform/unit-of-work/unit-of-work';
import { createSystemChangeRegistrar } from '../../src/platform/change-review/change-review';
import { ListRegistry } from '../support/shipping-fakes';
import {
  testAppConfig,
  TEST_MARKET_CONFIG_DIRS,
  TEST_MARKET_IDS,
  TEST_SERVICE_AREA_CONFIG_DIRS,
} from '../support/test-config';
import { ownerTestDatabaseUrl, testDatabaseUrl } from './test-database';

/** The harness's own registry registers shipping's real hooks under a test registrar. */
const SHIPPING_REGISTRAR = createSystemChangeRegistrar('shipping');

// What the System requests decision specs share (system-requests-concurrency and
// system-requests-decisions): the application graph on the run's database, the real request and
// policy stores, the real audit writer and outbox of system-requests, and the real shipping
// fleet-model hooks (a model edit is reviewed after it goes live, a model create waits for
// approval; area delivery is reviewed by default at medium risk, and no spec switches it off).
// The decision use cases run on their own registry, with shipping's real reverter and applier
// behind a switch that makes them fail after writing (a reverter or applier that throws), an
// authorisation check that answers yes, and a step-up port the test controls and counts.
// Models and accounts are new per test, so no other spec's rows are met.

const markets = new MarketRegistry(loadMarketConfigs(TEST_MARKET_CONFIG_DIRS, TEST_MARKET_IDS));
const serviceAreas = loadServiceAreas(TEST_SERVICE_AREA_CONFIG_DIRS, TEST_MARKET_IDS);

/** The step-up port of the decisions: grants a proof or refuses, and counts every spend. */
export class ControlledStepUp {
  grant = true;
  spent = 0;

  consume(context: CallContext, actionKey: string): Promise<Result<ConsumedStepUp, StepUpRefusal>> {
    this.spent += 1;
    if (!this.grant) return Promise.resolve(err({ code: 'second-factor.required', actionKey }));
    return Promise.resolve(
      ok({
        sessionId: (context.actor as { sessionId: Id<'Session'> }).sessionId,
        verifiedAt: Temporal.Now.instant(),
      }),
    );
  }
}

/** Makes the registered hooks throw after their own writes (and one outbox row) are made. */
export interface Faults {
  revert: boolean;
  apply: boolean;
}

export interface Harness {
  readonly app: INestApplicationContext;
  /** The application login, outside any unit (reads, and the lock waits of {@link whileLocked}). */
  readonly sql: Client;
  /** The database owner, for the row locks a test holds as a barrier. */
  readonly owner: Client;
  readonly requests: RequestRepository;
  readonly policy: PolicyRepository;
  /** The decision use cases' dependencies (their own registry, see the header). */
  readonly deps: SystemRequestsDependencies;
  readonly stepUp: ControlledStepUp;
  readonly faults: Faults;
  /** Shipping on the real recorder and proposer of the application. */
  readonly shipping: FleetModelCreateDependencies & ShippingApplierDependencies;
  close(): Promise<void>;
}

const allowAll: AuthorisationCheck = { check: () => Promise.resolve({ allowed: true }) };

export async function startHarness(
  options: { readonly authorisation?: AuthorisationCheck } = {},
): Promise<Harness> {
  const moduleRef = await Test.createTestingModule({
    imports: [
      AppModule.register({
        config: testAppConfig({ DATABASE_URL: testDatabaseUrl() }),
        logDestination: pino.destination(devNull),
      }),
    ],
  }).compile();
  const app = await moduleRef.init();
  const prisma = app.get(PrismaService);
  const reviews = app.select(SystemRequestsModule);
  const unitOfWork = app.get<UnitOfWork>(UNIT_OF_WORK);
  const clock = new FixedClock(Temporal.Now.instant());
  const ids = new UuidV7IdGenerator(clock);
  const shipping: FleetModelCreateDependencies & ShippingApplierDependencies = {
    unitOfWork,
    policy: new ConfigShippingPolicy(markets, serviceAreas),
    sellers: undefined as never,
    audit: app.select(ShippingModule).get<AuditWriter>(AUDIT_WRITER, { strict: true }),
    review: reviews.get<SystemRequestRecorder>(SYSTEM_REQUEST_RECORDER, { strict: true }),
    proposer: reviews.get<SystemActionProposer>(SYSTEM_ACTION_PROPOSER, { strict: true }),
    // The approver's keys come from identity in the app; its own specs cover the port.
    authorisation: allowAll,
    clock,
    ids,
    outbox: undefined as never,
    bookings: undefined as never,
    fleets: new ListRegistry([]),
    selection: new PrismaFleetSelectionRepository(prisma),
    deliverySettings: undefined as never,
    carrierPolicy: new ConfigCarrierPolicy(markets, serviceAreas, {
      apiKeys: {},
      webhookSecrets: {},
    }),
    quotes: undefined as never,
    ledger: undefined as never,
    pickups: undefined as never,
    webhookSignature: undefined as never,
    uberWebhookSignature: undefined as never,
    securityEvents: undefined as never,
    trail: undefined as never,
  };

  const faults: Faults = { revert: false, apply: false };
  const outbox = reviews.get<OutboxWriter>(OUTBOX_WRITER, { strict: true });
  /** One outbox row of the request (a registered event type), written before the throw. */
  const eventOf = (context: CallContext, requestId: Id<'SystemRequest'>) =>
    outbox.append(context, [
      SystemRequestOverdue.record({
        aggregateId: ids.next(),
        aggregateVersion: 1,
        occurredAt: clock.now(),
        payload: { requestId, number: 1, area: 'delivery', ageDays: 0 },
      }),
    ]);
  const realReverter = new FleetSelectionModelReverter(shipping);
  const reverter: SystemChangeReverter = {
    async revert(context, request) {
      const outcome = await realReverter.revert(context, request);
      if (faults.revert) {
        await eventOf(context, request.requestId);
        throw new Error('test reverter failed after writing');
      }
      return outcome;
    },
  };
  const realApplier = new FleetModelCreateApplier(shipping);
  const applier: SystemChangeApplier = {
    check: (context, request) => realApplier.check(context, request),
    async apply(context, request) {
      const outcome = await realApplier.apply(context, request);
      if (faults.apply) {
        await eventOf(context, request.requestId);
        throw new Error('test applier failed after writing');
      }
      return outcome;
    },
  };
  const registry = new ReverterRegistry();
  registry.register(SHIPPING_REGISTRAR, FLEET_MODEL_SUBJECT_KIND, 'delivery', reverter);
  registry.registerApplier(
    SHIPPING_REGISTRAR,
    FLEET_MODEL_CREATE_SUBJECT_KIND,
    'delivery',
    SHIPPING_APPLIER_PERMISSIONS.get(FLEET_MODEL_CREATE_SUBJECT_KIND)!,
    applier,
  );
  registry.seal();

  const requests = reviews.get<RequestRepository>(REQUEST_REPOSITORY, { strict: true });
  const policy = reviews.get<PolicyRepository>(POLICY_REPOSITORY, { strict: true });
  const stepUp = new ControlledStepUp();
  const deps: SystemRequestsDependencies = {
    unitOfWork,
    requests,
    policy,
    reverters: registry,
    authorisation: options.authorisation ?? allowAll,
    stepUp,
    audit: reviews.get<AuditWriter>(AUDIT_WRITER, { strict: true }),
    adminNames: { namesOf: () => Promise.resolve(new Map()) },
    ids: new UuidV7IdGenerator(app.get(CLOCK)),
    clock: app.get(CLOCK),
    impactCache: new ImpactCache(),
  };
  const sql = new Client({ connectionString: testDatabaseUrl() });
  await sql.connect();
  const owner = new Client({ connectionString: ownerTestDatabaseUrl() });
  await owner.connect();
  return {
    app,
    sql,
    owner,
    requests,
    policy,
    deps,
    stepUp,
    faults,
    shipping,
    async close() {
      await owner.end();
      await sql.end();
      await app.close();
    },
  };
}

/** A signed-in admin of `market`, acting as themselves, with a fresh account and session. */
export function adminOf(market: MarketContext, ids: UuidV7IdGenerator, name: string): CallContext {
  return testCallContext(
    market,
    testAuthenticatedActor(market, {
      population: 'admin',
      accountId: ids.next<'Account'>(),
      sessionId: ids.next<'Session'>(),
      sellerId: null,
    }),
    name,
  );
}

export const accountOf = (context: CallContext): Id<'Account'> =>
  (context.actor as { accountId: Id<'Account'> }).accountId;

/**
 * How long a race waits for its calls to queue behind the held lock before it fails. Generous, so
 * a loaded runner does not fail the test; a call that waits past the role's lock_timeout (3 s)
 * gives up, leaves the queue, and the wait then fails here as well rather than passing silently.
 */
export const QUEUE_WAIT_MS = 10_000;

/**
 * Waits until at least `waiters` sessions wait behind `pid` (directly, or behind another waiter),
 * looking on `watch`, a connection outside any transaction so that each look is fresh. Throws
 * once {@link QUEUE_WAIT_MS} has passed since `since`.
 */
async function queuedBehind(
  watch: Client,
  pid: number,
  waiters: number,
  since: number,
): Promise<void> {
  for (;;) {
    const waiting = await watch.query<{ count: number }>(
      `WITH RECURSIVE behind(pid) AS (
         SELECT pid FROM pg_stat_activity WHERE $1 = ANY (pg_blocking_pids(pid))
         UNION
         SELECT a.pid FROM pg_stat_activity a JOIN behind b ON b.pid = ANY (pg_blocking_pids(a.pid))
       )
       SELECT count(*)::int AS count FROM behind`,
      [pid],
    );
    const count = waiting.rows[0]!.count;
    if (count >= waiters) return;
    if (Date.now() - since > QUEUE_WAIT_MS) {
      throw new Error(
        `race barrier: ${count} of ${waiters} calls waited behind the lock after ${QUEUE_WAIT_MS} ms`,
      );
    }
  }
}

/**
 * Holds the row lock `lockSql` takes (as the owner, in a transaction) while `queue` runs, and lets
 * go when `queue` returns; the transaction ends whatever happens. Answers the owner's pid.
 */
async function holding<T>(
  owner: Client,
  lockSql: string,
  params: readonly unknown[],
  queue: (pid: number) => Promise<T>,
): Promise<T> {
  await owner.query('BEGIN');
  try {
    const locked = await owner.query(lockSql, [...params]);
    if (locked.rowCount !== 1) throw new Error('race barrier: the lock took no row');
    const { rows } = await owner.query<{ pid: number }>('SELECT pg_backend_pid() AS pid');
    return await queue(rows[0]!.pid);
  } finally {
    await owner.query('COMMIT');
  }
}

/** Keeps a refusal of a call that is awaited later from counting as unhandled meanwhile. */
const started = <T>(call: () => Promise<T>): Promise<T> => {
  const running = call();
  running.catch(() => undefined);
  return running;
};

/**
 * Runs `start` while the owner holds the row lock that `lockSql` takes, and lets go once at least
 * `waiters` sessions wait behind it, so the calls `start` makes meet at the lock instead of one
 * finishing before the other begins. Fails if they have not all queued within
 * {@link QUEUE_WAIT_MS}. Which call goes first is not chosen: use it where the calls are alike
 * (and {@link inQueueOrder} where the winner matters).
 */
export async function whileLocked<T>(
  owner: Client,
  watch: Client,
  lockSql: string,
  params: readonly unknown[],
  waiters: number,
  start: () => Promise<T>,
): Promise<T> {
  let running: Promise<T> | undefined;
  await holding(owner, lockSql, params, async (pid) => {
    const since = Date.now();
    running = started(start);
    await queuedBehind(watch, pid, waiters, since);
  });
  return running!;
}

/**
 * Runs two calls against one held row lock in a chosen order: `first` starts and is waited for
 * until it waits behind the lock, then `second` starts and queues behind it, then the lock is let
 * go. A row lock is granted in queue order, so `first` takes the row first. Fails if a call has
 * not queued within {@link QUEUE_WAIT_MS}.
 */
export async function inQueueOrder<A, B>(
  owner: Client,
  watch: Client,
  lockSql: string,
  params: readonly unknown[],
  first: () => Promise<A>,
  second: () => Promise<B>,
): Promise<[A, B]> {
  let a: Promise<A> | undefined;
  let b: Promise<B> | undefined;
  await holding(owner, lockSql, params, async (pid) => {
    a = started(first);
    await queuedBehind(watch, pid, 1, Date.now());
    b = started(second);
    await queuedBehind(watch, pid, 2, Date.now());
  });
  return Promise.all([a!, b!]);
}

/**
 * `deps` with a unit of work that counts the attempts of its read-write units, so a race can tell
 * whether a call's unit was retried (a serialisation failure or deadlock, retried by the unit of
 * work). Under SERIALIZABLE a unit can fail on a false positive caused by another spec's units on
 * nearby rows; retried, it queues again behind the other call, which may then win.
 */
export function tracked<D extends { readonly unitOfWork: UnitOfWork }>(
  deps: D,
): { readonly deps: D; readonly retried: () => boolean } {
  let attempts = 0;
  const unitOfWork: UnitOfWork = {
    run: (market, work, options) =>
      deps.unitOfWork.run(
        market,
        options?.readOnly === true
          ? work
          : () => {
              attempts += 1;
              return work();
            },
        options,
      ),
    runOnce: (market, delivery, work, options) =>
      deps.unitOfWork.runOnce(market, delivery, work, options),
  };
  return { deps: { ...deps, unitOfWork }, retried: () => attempts > 1 };
}

/** The lock a decision takes first: the request's row. */
export const REQUEST_ROW_LOCK =
  'SELECT 1 FROM system_requests.requests WHERE market_id = $1 AND id = $2 FOR UPDATE';
/** The lock a reverter takes when it restores a fleet-selection model: the model's row. */
export const MODEL_ROW_LOCK =
  'SELECT 1 FROM shipping.fleet_selection_models WHERE market_id = $1 AND id = $2 FOR UPDATE';
/** The lock a proposal takes first: the Market's request counter. */
export const COUNTER_ROW_LOCK =
  'SELECT 1 FROM system_requests.request_counters WHERE market_id = $1 FOR UPDATE';

export const RULE = { kind: 'fixed_priority', order: ['mondapac_drive', 'zoom2u'] };

/** A model created at once (the proposer files nothing), then edited by `author` with a note. */
export async function editedModel(
  h: Harness,
  author: CallContext,
  name: string,
  options: { readonly risk?: 'high' } = {},
): Promise<{
  readonly modelId: string;
  readonly requestId: Id<'SystemRequest'>;
  readonly before: string;
  readonly after: string;
}> {
  const created = await createFleetSelectionModel(
    { ...h.shipping, proposer: { proposeChange: () => Promise.resolve(ok(null)) } },
    author,
    { name, rule: { kind: 'cheapest' } },
  );
  if (!created.ok || !('id' in created.value)) throw new Error('model not created');
  const modelId = created.value.id;
  const after = `${name} edited`;
  const recorder = h.shipping.review;
  const review: SystemRequestRecorder =
    options.risk === undefined
      ? recorder
      : {
          openReview: (context, change) =>
            recorder.openReview(context, { ...change, risk: options.risk }),
          areaPolicy: (context, area) => recorder.areaPolicy(context, area),
        };
  const edited = await updateFleetSelectionModel({ ...h.shipping, review }, author, {
    modelId,
    name: after,
    rule: RULE,
    expectedVersion: 1,
    note: 'Our drivers first',
  });
  if (!edited.ok || edited.value.request === null) throw new Error('no request opened');
  return { modelId, requestId: edited.value.request.id, before: name, after };
}
