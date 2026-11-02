import { ok, Temporal, uuidV7 } from '@mondapac/shared-kernel';
import type { Id, MarketContext } from '@mondapac/shared-kernel';
import { Client } from 'pg';
import { RelaxationAlreadyOpenError } from '../../src/modules/catalog/application/ports/attribute-relaxation.store';
import {
  AttributeDefinition,
  DEFAULT_DISPLAY_SETTINGS,
} from '../../src/modules/catalog/domain/attribute-definition';
import { AttributeRelaxationRequest } from '../../src/modules/catalog/domain/attribute-relaxation-request';
import { PrismaAttributeDefinitionStore } from '../../src/modules/catalog/infrastructure/prisma-attribute-definition.store';
import { PrismaAttributeRelaxationStore } from '../../src/modules/catalog/infrastructure/prisma-attribute-relaxation.store';
import { StaleAggregateError } from '../../src/platform/unit-of-work/errors';
import { TEST_MARKETS } from '../support/test-config';
import {
  createPersistence,
  marketOf,
  otherMarketOf,
  type Persistence,
} from './persistence-support';
import { ownerTestDatabaseUrl } from './test-database';

// The two-person request to clear `material` on PostgreSQL (catalog data design 3.21 and the 3.5
// M2 trigger; attributes A2 part 3), for both Market fixtures, as the API role: a request and its
// confirm clear `material` in a revision that names it; one open request per attribute; a move
// only from open at its version; the Market boundary; and the database backstops that hold
// without the use case: clearing `material` on a published attribute without a confirmed request,
// a revision naming a request when it clears nothing, the same admin confirming, a closed request
// changing, a delete. Times are the real clock's (the guard allows closed_at only within five
// minutes of the statement). Each test works on its own codes, because other specs share the
// database.

let sequence = 0;
const uuid7 = (): string =>
  uuidV7(Date.now() + sequence++, crypto.getRandomValues(new Uint8Array(10)));
const unique = () => `r${uuid7().replaceAll('-', '').slice(-10)}`;
const now = () => Temporal.Now.instant().round({ smallestUnit: 'millisecond' });

describe.each(TEST_MARKETS)('catalog attribute relaxation in market %s (database)', (code) => {
  const market = marketOf(code);
  const other = marketOf(otherMarketOf(code));
  const locale = code === 'AU' ? 'en-AU' : 'ja-JP';
  const first = uuid7() as Id<'Account'>;
  const second = uuid7() as Id<'Account'>;
  let db: Persistence;
  let owner: Client;
  let definitions: PrismaAttributeDefinitionStore;
  let relaxations: PrismaAttributeRelaxationStore;

  beforeAll(async () => {
    db = createPersistence();
    owner = new Client({ connectionString: ownerTestDatabaseUrl() });
    await owner.connect();
    definitions = new PrismaAttributeDefinitionStore(db.service);
    relaxations = new PrismaAttributeRelaxationStore(db.service);
  });
  afterAll(async () => {
    await owner.end();
    await db.close();
  });

  const write = async <T>(target: MarketContext, work: () => Promise<T>) => {
    const result = await db.unitOfWork.run(target, async () => ok(await work()));
    if (!result.ok) throw new Error('unit failed');
    return result.value;
  };
  const read = async <T>(target: MarketContext, work: () => Promise<T>) => {
    const result = await db.unitOfWork.run(target, async () => ok(await work()), {
      readOnly: true,
    });
    if (!result.ok) throw new Error('unit failed');
    return result.value;
  };
  const sqlState = async (work: Promise<unknown>) => {
    try {
      await work;
      return 'none';
    } catch (error) {
      return (error as { code?: string }).code ?? 'unknown';
    }
  };
  const driverCode = async (work: Promise<unknown>) => {
    try {
      await work;
      return 'none';
    } catch (error) {
      const e = error as {
        code?: string;
        meta?: { driverAdapterError?: { cause?: { originalCode?: string } } };
        cause?: { code?: string };
      };
      return (
        e.meta?.driverAdapterError?.cause?.originalCode ?? e.cause?.code ?? e.code ?? 'unknown'
      );
    }
  };

  /** A published material select attribute (version 2). */
  async function publishedMaterial(material = true): Promise<AttributeDefinition> {
    const built = AttributeDefinition.createDraft({
      id: uuid7() as Id<'AttributeDefinition'>,
      revisionId: uuid7() as Id<'AttributeDefinitionRevision'>,
      marketId: market.marketId,
      code: unique(),
      dataType: 'select',
      localizable: false,
      material,
      isVariantOption: false,
      bounds: {},
      names: { [locale]: 'Allergens' },
      options: [{ code: 'nuts', labels: { [locale]: 'Nuts' }, active: true, position: 0 }],
      display: DEFAULT_DISPLAY_SETTINGS,
      now: now(),
    });
    if (!built.ok) throw new Error(built.error.code);
    await write(market, () => definitions.addDraft(market, built.value, first));
    const published = built.value.publish(locale);
    if (!published.ok) throw new Error(published.error.code);
    await write(market, () => definitions.saveStatus(market, published.value));
    return published.value;
  }

  const requestFor = (definition: AttributeDefinition, at = now()) =>
    AttributeRelaxationRequest.open({
      id: uuid7() as Id<'AttributeRelaxationRequest'>,
      marketId: market.marketId,
      definitionId: definition.state.id,
      definitionVersion: definition.state.version,
      kind: 'clear-material',
      requestedByAccountId: first,
      now: at,
    });

  const cleared = (definition: AttributeDefinition) => {
    const next = definition.clearMaterial({
      revisionId: uuid7() as Id<'AttributeDefinitionRevision'>,
      now: now(),
    });
    if (!next.ok) throw new Error(next.error.code);
    return next.value;
  };

  it('clears material through a confirmed request; the revision names it, once', async () => {
    const definition = await publishedMaterial();
    const request = requestFor(definition);
    await write(market, () => relaxations.add(market, request));
    expect(await read(market, () => relaxations.openOf(market, definition.state.id))).toEqual(
      request,
    );
    expect(await read(other, () => relaxations.findById(other, request.state.id))).toBeNull();

    const confirmed = request.confirm(second, now());
    if (!confirmed.ok) throw new Error(confirmed.error.code);
    const next = cleared(definition);
    await write(market, async () => {
      expect(
        await definitions.lockAtVersion(market, definition.state.id, definition.state.version),
      ).toBe(true);
      await relaxations.saveMove(market, confirmed.value);
      await definitions.saveRevision(market, next, second, request.state.id);
    });
    const found = await read(market, () => definitions.findById(market, definition.state.id));
    expect(found?.state).toMatchObject({ material: false, status: 'active', version: 3 });
    const { rows } = await owner.query<{
      relaxation_request_id: string;
      author_account_id: string;
    }>(
      'SELECT relaxation_request_id, author_account_id FROM catalog.attribute_definition_revisions WHERE id = $1',
      [next.state.revisionId],
    );
    expect(rows).toEqual([{ relaxation_request_id: request.state.id, author_account_id: second }]);
    expect(
      (await read(market, () => relaxations.findById(market, request.state.id)))?.state,
    ).toMatchObject({ status: 'confirmed', confirmedByAccountId: second, version: 2 });
  });

  it('refuses clearing material on a published attribute without a confirmed request', async () => {
    const definition = await publishedMaterial();
    const next = cleared(definition);
    expect(
      await driverCode(write(market, () => definitions.saveRevision(market, next, first))),
    ).toBe('23514');
    // An open (not yet confirmed) request is not enough either.
    const request = requestFor(definition);
    await write(market, () => relaxations.add(market, request));
    expect(
      await driverCode(
        write(market, () => definitions.saveRevision(market, next, first, request.state.id)),
      ),
    ).toBe('23514');
    expect(
      (await read(market, () => definitions.findById(market, definition.state.id)))?.state.material,
    ).toBe(true);
  });

  it('refuses a revision that names a request but clears nothing; a draft clears material freely', async () => {
    const definition = await publishedMaterial(false);
    const renamed = definition.revise({
      revisionId: uuid7() as Id<'AttributeDefinitionRevision'>,
      names: { [locale]: 'Allergen list' },
      material: false,
      isVariantOption: false,
      bounds: {},
      options: definition.state.options,
      display: definition.state.display,
      now: now(),
    });
    if (!renamed.ok) throw new Error(renamed.error.code);
    const material = await publishedMaterial();
    const request = requestFor(material);
    await write(market, () => relaxations.add(market, request));
    // A request of another attribute: the same-definition foreign key refuses it first.
    expect(
      await driverCode(
        write(market, () =>
          definitions.saveRevision(market, renamed.value, first, request.state.id),
        ),
      ),
    ).not.toBe('none');

    const draft = AttributeDefinition.createDraft({
      id: uuid7() as Id<'AttributeDefinition'>,
      revisionId: uuid7() as Id<'AttributeDefinitionRevision'>,
      marketId: market.marketId,
      code: unique(),
      dataType: 'text',
      localizable: false,
      material: true,
      isVariantOption: false,
      bounds: {},
      names: { [locale]: 'Origin' },
      options: [],
      display: DEFAULT_DISPLAY_SETTINGS,
      now: now(),
    });
    if (!draft.ok) throw new Error(draft.error.code);
    await write(market, () => definitions.addDraft(market, draft.value, first));
    const off = draft.value.revise({
      revisionId: uuid7() as Id<'AttributeDefinitionRevision'>,
      names: { [locale]: 'Origin' },
      material: false,
      isVariantOption: false,
      bounds: {},
      options: [],
      display: DEFAULT_DISPLAY_SETTINGS,
      now: now(),
    });
    if (!off.ok) throw new Error(off.error.code);
    await write(market, () => definitions.saveRevision(market, off.value, first));
  });

  it('keeps one open request per attribute and moves a request only from open at its version', async () => {
    const definition = await publishedMaterial();
    const request = requestFor(definition);
    await write(market, () => relaxations.add(market, request));
    await expect(
      write(market, () => relaxations.add(market, requestFor(definition))),
    ).rejects.toBeInstanceOf(RelaxationAlreadyOpenError);
    const cancelled = request.cancel(first, now());
    if (!cancelled.ok) throw new Error(cancelled.error.code);
    await write(market, () => relaxations.saveMove(market, cancelled.value));
    await expect(
      write(market, () => relaxations.saveMove(market, cancelled.value)),
    ).rejects.toBeInstanceOf(StaleAggregateError);
    // Closed, so a new one may open.
    await write(market, () => relaxations.add(market, requestFor(definition)));
  });

  it('holds the two-person rule, the one-way status and no delete without the use case', async () => {
    const definition = await publishedMaterial();
    const request = requestFor(definition);
    await write(market, () => relaxations.add(market, request));
    const id = request.state.id;
    expect(
      await sqlState(
        owner.query(
          `UPDATE catalog.attribute_relaxation_requests
              SET status = 'confirmed', confirmed_by_account_id = requested_by_account_id,
                  closed_at = now(), version = 2
            WHERE market_id = $1 AND id = $2`,
          [market.marketId, id],
        ),
      ),
    ).toBe('23514');
    expect(
      await sqlState(
        owner.query(
          `UPDATE catalog.attribute_relaxation_requests SET definition_version = 9, version = 2
            WHERE market_id = $1 AND id = $2`,
          [market.marketId, id],
        ),
      ),
    ).toBe('23001');
    expect(
      await sqlState(
        owner.query(
          `UPDATE catalog.attribute_relaxation_requests
              SET status = 'cancelled', cancel_reason = 'requester',
                  closed_at = now() - interval '1 hour', version = 2
            WHERE market_id = $1 AND id = $2`,
          [market.marketId, id],
        ),
      ),
    ).toBe('23514');
    await owner.query(
      `UPDATE catalog.attribute_relaxation_requests
          SET status = 'cancelled', cancel_reason = 'requester', closed_at = now(), version = 2
        WHERE market_id = $1 AND id = $2`,
      [market.marketId, id],
    );
    expect(
      await sqlState(
        owner.query(
          `UPDATE catalog.attribute_relaxation_requests SET status = 'open', version = 3,
                  cancel_reason = NULL, closed_at = NULL
            WHERE market_id = $1 AND id = $2`,
          [market.marketId, id],
        ),
      ),
    ).toBe('23001');
    expect(
      await sqlState(
        owner.query(
          'DELETE FROM catalog.attribute_relaxation_requests WHERE market_id = $1 AND id = $2',
          [market.marketId, id],
        ),
      ),
    ).toBe('23001');
  });

  it('lists open requests in time and those whose time ran out, apart', async () => {
    const fresh = await publishedMaterial();
    const old = await publishedMaterial();
    const inTime = requestFor(fresh);
    const late = requestFor(old, now().subtract({ hours: 80 }));
    await write(market, async () => {
      await relaxations.add(market, inTime);
      await relaxations.add(market, late);
    });
    const at = now();
    const open = await read(market, () => relaxations.listOpen(market, at, 100));
    const expired = await read(market, () => relaxations.listExpired(market, at, 100));
    expect(open.map((r) => r.state.id)).toContain(inTime.state.id);
    expect(open.map((r) => r.state.id)).not.toContain(late.state.id);
    expect(expired.map((r) => r.state.id)).toContain(late.state.id);
    expect(expired.map((r) => r.state.id)).not.toContain(inTime.state.id);
    const done = late.expire(at);
    if (!done.ok) throw new Error(done.error.code);
    await write(market, () => relaxations.saveMove(market, done.value));
    expect(
      (await read(market, () => relaxations.listExpired(market, at, 100))).map((r) => r.state.id),
    ).not.toContain(late.state.id);
    expect(
      (await read(other, () => relaxations.listOpen(other, at, 100))).map((r) => r.state.id),
    ).not.toContain(inTime.state.id);
  });
});
