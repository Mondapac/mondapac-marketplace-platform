import { ok, Temporal } from '@mondapac/shared-kernel';
import type { Id, MarketContext } from '@mondapac/shared-kernel';
import { FixedClock } from '@mondapac/shared-kernel/testing';
import { Client } from 'pg';
import { PrismaConversationRepository } from '../../src/modules/assistant/infrastructure/prisma-conversation.repository';
import { PrismaFeedbackRepository } from '../../src/modules/assistant/infrastructure/prisma-feedback.repository';
import { PrismaInsightsRepository } from '../../src/modules/assistant/infrastructure/prisma-insights.repository';
import { PrismaSpendRepository } from '../../src/modules/assistant/infrastructure/prisma-spend.repository';
import { PrismaSubjectKeyStore } from '../../src/platform/persistence/prisma-subject-key-store';
import { LocalKeyWrapper } from '../../src/platform/subject-keys/local-key-wrapper';
import { NodeSubjectKeyService } from '../../src/platform/subject-keys/node-subject-key-service';
import { TEST_MARKETS } from '../support/test-config';
import { ids } from './outbox-support';
import {
  createPersistence,
  marketOf,
  otherMarketOf,
  randomUUID,
  type Persistence,
} from './persistence-support';
import { testDatabaseUrl } from './test-database';
import { assistantUsageReport, settleBuyerChat } from './assistant-usage-report';

// The assistant's feedback and insights as the application role, in both Market fixtures: one
// thumbs per assistant message (the last write wins), the CHECKs and grants, the cascade from a
// purged conversation, and the aggregates the admin reads: per day, thumbs, hand-offs and the
// unanswered turns with the buyer's text decrypted, scoped to one Market and to the range.

const CHECK = '23514';
const DENIED = '42501';
const T0 = Temporal.Instant.from('2026-11-10T01:00:00Z');
// Each test works in its own window (30 days apart), so nothing one test wrote is seen by another.
let slot = 0;

describe.each(TEST_MARKETS)(
  'assistant feedback and insights store in market %s (database)',
  (code) => {
    const market = marketOf(code);
    const other = marketOf(otherMarketOf(code));
    const clock = new FixedClock(T0);
    let base = T0;
    let FROM = T0;
    let TO = T0;
    let FROM_DAY = Temporal.PlainDate.from('2026-11-09');
    let TO_DAY = Temporal.PlainDate.from('2026-11-11');
    const dayOf = (offset: number) =>
      base.toZonedDateTimeISO('UTC').toPlainDate().add({ days: offset });
    let db: Persistence;
    let keys: NodeSubjectKeyService;
    let conversations: PrismaConversationRepository;
    let feedback: PrismaFeedbackRepository;
    let insights: PrismaInsightsRepository;
    let spend: PrismaSpendRepository;
    let sql: Client;

    beforeAll(async () => {
      db = createPersistence();
      keys = new NodeSubjectKeyService(
        new PrismaSubjectKeyStore(db.service, db.unitOfWork),
        new LocalKeyWrapper({ nodeEnv: 'test', nodeEnvExplicit: true }),
        clock,
      );
      conversations = new PrismaConversationRepository(db.service, keys);
      feedback = new PrismaFeedbackRepository(db.service);
      insights = new PrismaInsightsRepository(db.service, keys, assistantUsageReport(db.service));
      spend = new PrismaSpendRepository(db.service, assistantUsageReport(db.service));
      sql = new Client({ connectionString: testDatabaseUrl() });
      await sql.connect();
    });
    afterAll(async () => {
      await sql.end();
      await db.close();
    });
    beforeEach(() => {
      slot += 1;
      base = base.add({ hours: 24 * 30 * slot });
      FROM = base.subtract({ hours: 2 });
      TO = base.add({ hours: 20 });
      FROM_DAY = dayOf(-1);
      TO_DAY = dayOf(1);
    });

    const inUnit = async <T>(target: MarketContext, work: () => Promise<T>): Promise<T> => {
      const result = await db.unitOfWork.run(target, async () => ok(await work()));
      if (!result.ok) throw new Error('unreachable');
      return result.value;
    };

    /** A guest conversation with the given exchanges, each `[buyer text, reply flags]`. */
    async function conversation(
      exchanges: readonly {
        text: string;
        at?: Temporal.Instant;
        notices?: string[];
        emptySearch?: boolean;
        cards?: string[];
      }[],
      target = market,
      retentionDays: 0 | 30 = 30,
    ) {
      const conversationId: string = ids.next<'Conversation'>();
      await inUnit(target, async () => {
        await conversations.create(target, {
          id: conversationId,
          owner: { kind: 'guest', tokenHash: randomUUID().replaceAll('-', '').padEnd(64, '0') },
          turns: 0,
          retentionDays,
          startedAt: base,
        });
        // A conversation that keeps no text has no key and no messages (the use case never appends).
        for (const exchange of retentionDays === 0 ? [] : exchanges) {
          const at = exchange.at ?? base;
          await conversations.append(target, conversationId, {
            role: 'buyer',
            text: exchange.text,
            cards: [],
            at,
          });
          await conversations.append(target, conversationId, {
            role: 'assistant',
            text: 'A reply.',
            cards: exchange.cards ?? [],
            at,
            notices: exchange.notices ?? [],
            emptySearch: exchange.emptySearch ?? false,
          });
        }
      });
      return conversationId;
    }

    const give = (
      conversationId: string,
      position: number,
      rating: 'up' | 'down',
      reason: 'wrong' | 'not-found' | 'other' | null = null,
      at = base,
      target = market,
    ) =>
      inUnit(target, () => feedback.save(target, conversationId, position, { rating, reason }, at));
    const failure = (promise: Promise<unknown>) =>
      promise.then(
        () => null,
        (error: { code?: string }) => error.code,
      );

    describe('thumbs', () => {
      it('keeps one thumbs per assistant message, the last write winning, and only on an assistant message', async () => {
        const conversationId = await conversation([{ text: 'dates?' }]);
        await expect(give(conversationId, 2, 'down', 'wrong')).resolves.toBe(true);
        await expect(give(conversationId, 2, 'up', null, base.add({ minutes: 5 }))).resolves.toBe(
          true,
        );
        // The buyer's own line and a missing position take none.
        await expect(give(conversationId, 1, 'up')).resolves.toBe(false);
        await expect(give(conversationId, 3, 'up')).resolves.toBe(false);
        // Another Market cannot reach it.
        await expect(give(conversationId, 2, 'up', null, base, other)).resolves.toBe(false);

        const rows = await sql.query<{
          rating: string;
          reason: string | null;
          created_at: Date;
          updated_at: Date;
        }>(
          'SELECT rating, reason, created_at, updated_at FROM assistant.feedback WHERE conversation_id = $1',
          [conversationId],
        );
        expect(rows.rows).toHaveLength(1);
        expect(rows.rows[0]).toMatchObject({ rating: 'up', reason: null });
        expect(rows.rows[0]!.created_at.toISOString()).toBe(
          base.toString().replace(':00Z', ':00.000Z'),
        );
        expect(rows.rows[0]!.updated_at.getTime()).toBe(base.add({ minutes: 5 }).epochMilliseconds);
      });

      it('goes with its conversation when the conversation is deleted', async () => {
        const conversationId = await conversation([{ text: 'old question', at: base }]);
        await give(conversationId, 2, 'down', 'other');
        // The purge deletes the conversation row; the messages and their thumbs follow by cascade.
        await sql.query('DELETE FROM assistant.conversations WHERE id = $1', [conversationId]);
        const left = await sql.query(
          'SELECT 1 FROM assistant.feedback WHERE conversation_id = $1',
          [conversationId],
        );
        expect(left.rowCount).toBe(0);
      });

      describe('CHECKs and grants (application role)', () => {
        const insertFeedback = (
          conversationId: string,
          overrides: Record<string, unknown> = {},
        ) => {
          const row: Record<string, unknown> = {
            market_id: market.marketId,
            tenant_id: market.tenantId,
            conversation_id: conversationId,
            position: 2,
            rating: 'down',
            reason: 'wrong',
            created_at: '2026-11-10T01:00:00Z',
            updated_at: '2026-11-10T01:00:00Z',
            ...overrides,
          };
          const columns = Object.keys(row);
          return sql.query(
            `INSERT INTO assistant.feedback (${columns.join(', ')})
           VALUES (${columns.map((_c, i) => `$${i + 1}`).join(', ')})`,
            Object.values(row),
          );
        };

        it('refuses a reason with a thumbs up, and an unknown value', async () => {
          const conversationId = await conversation([{ text: 'x' }]);
          await expect(failure(insertFeedback(conversationId, { rating: 'up' }))).resolves.toBe(
            CHECK,
          );
          await expect(failure(insertFeedback(conversationId, { reason: 'rude' }))).resolves.toBe(
            CHECK,
          );
          await expect(
            failure(insertFeedback(conversationId, { rating: 'five', reason: null })),
          ).resolves.toBe(CHECK);
          await expect(
            insertFeedback(conversationId, { rating: 'up', reason: null }),
          ).resolves.toBeDefined();
        });

        it('refuses a thumbs on a message that does not exist', async () => {
          const conversationId = await conversation([{ text: 'x' }]);
          await expect(failure(insertFeedback(conversationId, { position: 9 }))).resolves.toBe(
            '23503',
          );
        });

        it('cannot move a thumbs to another message, or delete one', async () => {
          const conversationId = await conversation([{ text: 'x' }]);
          await give(conversationId, 2, 'down', 'wrong');
          await expect(
            failure(sql.query('UPDATE assistant.feedback SET position = 1')),
          ).resolves.toBe(DENIED);
          await expect(
            failure(sql.query('UPDATE assistant.feedback SET created_at = now()')),
          ).resolves.toBe(DENIED);
          await expect(failure(sql.query('DELETE FROM assistant.feedback'))).resolves.toBe(DENIED);
          await expect(
            sql.query(
              "UPDATE assistant.feedback SET rating = 'up', reason = NULL, updated_at = updated_at",
            ),
          ).resolves.toBeDefined();
        });

        it('refuses a notice list with a null or more than 8 entries', async () => {
          const conversationId = await conversation([{ text: 'x' }]);
          await expect(
            failure(
              sql.query(
                `INSERT INTO assistant.messages (market_id, tenant_id, conversation_id, position, role, text_cipher, cards, notices, created_at)
               VALUES ($1, $2, $3, 5, 'assistant', 'c', '{}', ARRAY['a','b','c','d','e','f','g','h','i'], now())`,
                [market.marketId, market.tenantId, conversationId],
              ),
            ),
          ).resolves.toBe(CHECK);
        });
      });
    });

    describe('the insights', () => {
      it('counts conversations and spend per Market day, inside the range and the Market only', async () => {
        const add = async (
          target: MarketContext,
          d: Temporal.PlainDate,
          microUsd: number,
          conversationsAdded: number,
        ) => {
          // The spend is the gateway's settled cost (G7b); the conversations are the assistant's.
          await settleBuyerChat(sql, target, d, microUsd);
          await inUnit(target, () =>
            spend.add(target, d, {
              microUsd,
              inputTokens: 10,
              outputTokens: 5,
              conversations: conversationsAdded,
            }),
          );
        };
        await add(market, dayOf(-2), 111, 9); // before the range
        await add(market, dayOf(-1), 1000, 2);
        await add(market, dayOf(1), 500, 1);
        await add(market, dayOf(2), 222, 7); // after the range
        await add(other, dayOf(0), 999, 5); // another Market

        const days = await inUnit(market, () => insights.days(market, FROM_DAY, TO_DAY));
        expect(days.map((d) => [d.day.toString(), d.conversations, d.spendMicroUsd])).toEqual([
          [dayOf(-1).toString(), 2, 1000],
          [dayOf(1).toString(), 1, 500],
        ]);
      });

      it('shares the thumbs by reason, for messages written in the range, in this Market only', async () => {
        const inside = await conversation([
          { text: 'a' },
          { text: 'b' },
          { text: 'c' },
          { text: 'd' },
        ]);
        await give(inside, 2, 'up');
        await give(inside, 4, 'down', 'wrong');
        await give(inside, 6, 'down', 'not-found');
        await give(inside, 8, 'down');
        const outside = await conversation([{ text: 'old', at: base.subtract({ hours: 24 * 5 }) }]);
        await give(outside, 2, 'down', 'other');
        const elsewhere = await conversation([{ text: 'x' }], other);
        await give(elsewhere, 2, 'down', 'other', base, other);

        await expect(inUnit(market, () => insights.feedback(market, FROM, TO))).resolves.toEqual({
          up: 1,
          down: 3,
          reasons: { wrong: 1, 'not-found': 1, other: 0 },
        });
      });

      it('counts the replies that showed the support card', async () => {
        await conversation([
          { text: 'a', cards: ['support'] },
          { text: 'b', cards: ['product:x', 'support'] },
          { text: 'c', cards: ['product:x'] },
          { text: 'old', cards: ['support'], at: base.subtract({ hours: 24 * 5 }) },
        ]);
        await conversation([{ text: 'elsewhere', cards: ['support'] }], other);
        await expect(inUnit(market, () => insights.handoffs(market, FROM, TO))).resolves.toBe(2);
      });

      it('returns the turns that were not served well, with the buyer text, newest first', async () => {
        const id1 = await conversation([
          { text: 'is there saffron?', at: base, emptySearch: true },
          { text: 'fine question', at: base.add({ minutes: 1 }) },
          {
            text: 'tell me about lamb',
            at: base.add({ minutes: 2 }),
            notices: ['unavailable', 'refused'],
          },
          { text: 'halal ghee', at: base.add({ minutes: 3 }), notices: ['tool-failed'] },
          { text: 'see-cards only', at: base.add({ minutes: 4 }), notices: ['see-cards'] },
          { text: 'a wrong answer', at: base.add({ minutes: 5 }) },
        ]);
        await give(id1, 12, 'down', 'wrong');
        await give(id1, 2, 'up'); // an up is not unanswered
        await conversation([
          { text: 'too old', emptySearch: true, at: base.subtract({ hours: 24 * 5 }) },
        ]);
        await conversation([{ text: 'another market', emptySearch: true }], other);
        await conversation([{ text: 'kept no text', emptySearch: true }], market, 0);

        const found = await inUnit(market, () => insights.unanswered(market, FROM, TO, 100));
        expect(found.map((c) => [c.text, c.reasons])).toEqual([
          ['a wrong answer', ['thumbs-down']],
          ['halal ghee', ['tool-failed']],
          ['tell me about lamb', ['unavailable']],
          ['is there saffron?', ['no-results']],
        ]);
        expect(found[0]!.at.toString()).toBe(base.add({ minutes: 5 }).toString());
      });

      it('stops at the limit, newest first, and skips a conversation whose key is gone', async () => {
        const gone = await conversation([{ text: 'purged question', emptySearch: true }]);
        await conversation([
          { text: 'one', emptySearch: true, at: base.add({ minutes: 1 }) },
          { text: 'two', emptySearch: true, at: base.add({ minutes: 2 }) },
        ]);
        await inUnit(market, () => keys.destroyKey(market, gone as Id<'Conversation'>));

        const limited = await inUnit(market, () => insights.unanswered(market, FROM, TO, 1));
        expect(limited.map((c) => c.text)).toEqual(['two']);
        const all = await inUnit(market, () => insights.unanswered(market, FROM, TO, 10));
        expect(all.map((c) => c.text)).toEqual(['two', 'one']);
      });

      it('has the partial index the unanswered read relies on', async () => {
        const index = await sql.query(
          "SELECT 1 FROM pg_indexes WHERE schemaname = 'assistant' AND indexname = 'messages_market_id_created_at_unanswered_idx'",
        );
        expect(index.rowCount).toBe(1);
      });
    });
  },
);
