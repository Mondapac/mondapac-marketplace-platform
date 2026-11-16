import type { Id, MarketContext } from '@mondapac/shared-kernel';
import type { PrismaService } from '../../../platform/persistence/prisma.service';
import { fieldLabel } from '../../../platform/subject-keys/labels';
import type { SubjectKeyService } from '../../../platform/subject-keys/subject-key-service';
import { Temporal } from '@mondapac/shared-kernel';
import type {
  ConversationCursor,
  ConversationListPage,
  ConversationOwner,
  ConversationRecord,
  ConversationRepository,
  ConversationSummary,
  FoundConversation,
  StoredMessage,
  TranscriptMessage,
} from '../application/ports/conversation.repository';

/** The label bound into every message ciphertext (PF 4 row 3). */
const MESSAGE_TEXT = fieldLabel('assistant.message.text');

/** The retention values a conversation can store (the table's CHECK). */
const STORED_RETENTIONS = [0, 30, 365] as const;

const DAY_MS = 24 * 60 * 60 * 1000;

const dateOf = (instant: Temporal.Instant): Date => new Date(instant.epochMilliseconds);
const instantOf = (date: Date): Temporal.Instant =>
  Temporal.Instant.fromEpochMilliseconds(date.getTime());

/**
 * {@link ConversationRepository} on `assistant.conversations` and `assistant.messages`, scoped by
 * `marketId`. Each conversation is its own subject: its key is created with it (only when text
 * is kept) and destroyed by the purge, so message text never outlives its retention, not even in
 * a backup copy of a row.
 */
export class PrismaConversationRepository implements ConversationRepository {
  constructor(
    private readonly prisma: PrismaService,
    private readonly keys: SubjectKeyService,
  ) {}

  async find(market: MarketContext, id: string): Promise<FoundConversation | null> {
    const row = await this.prisma.tx(market).assistantConversation.findFirst({
      where: { marketId: market.marketId, id },
      select: {
        id: true,
        accountId: true,
        guestTokenHash: true,
        turns: true,
        retentionDays: true,
        startedAt: true,
        lastMessageAt: true,
      },
    });
    if (row === null) return null;
    const owner: ConversationOwner =
      row.accountId !== null
        ? { kind: 'account', accountId: row.accountId as Id<'Account'> }
        : { kind: 'guest', tokenHash: Buffer.from(row.guestTokenHash!).toString('hex') };
    return {
      id: row.id,
      owner,
      turns: row.turns,
      retentionDays: row.retentionDays,
      startedAt: instantOf(row.startedAt),
      lastMessageAt: instantOf(row.lastMessageAt),
    };
  }

  spent(market: MarketContext, id: string): Promise<boolean> {
    return this.keys.hasHadKey(market, id as Id<'Conversation'>);
  }

  async create(
    market: MarketContext,
    conversation: ConversationRecord & { readonly startedAt: Temporal.Instant },
  ): Promise<boolean> {
    const { owner } = conversation;
    // A spent id would fail createKey (a subject has one key for life) and roll the whole unit
    // back, spend included: answer "taken" instead (Hassan, PR 947).
    if (conversation.retentionDays > 0 && (await this.spent(market, conversation.id))) {
      return false;
    }
    const created = await this.prisma.tx(market).assistantConversation.createMany({
      data: [
        {
          id: conversation.id,
          marketId: market.marketId,
          tenantId: market.tenantId,
          accountId: owner.kind === 'account' ? owner.accountId : null,
          guestTokenHash: owner.kind === 'guest' ? Buffer.from(owner.tokenHash, 'hex') : null,
          turns: conversation.turns,
          retentionDays: conversation.retentionDays,
          startedAt: dateOf(conversation.startedAt),
          lastMessageAt: dateOf(conversation.startedAt),
        },
      ],
      skipDuplicates: true,
    });
    if (created.count !== 1) return false;
    if (conversation.retentionDays > 0) {
      await this.keys.createKey(market, conversation.id as Id<'Conversation'>);
    }
    return true;
  }

  async history(
    market: MarketContext,
    id: string,
    limit: number,
  ): Promise<readonly StoredMessage[]> {
    const rows = await this.prisma.tx(market).assistantMessage.findMany({
      where: { marketId: market.marketId, conversationId: id },
      orderBy: { position: 'desc' },
      take: limit,
      select: { role: true, textCipher: true },
    });
    const messages: StoredMessage[] = [];
    for (const row of rows.reverse()) {
      const text = await this.keys.decrypt(
        market,
        id as Id<'Conversation'>,
        MESSAGE_TEXT,
        row.textCipher,
      );
      // A destroyed key is a purged conversation: nothing to read.
      if (!text.ok) return [];
      messages.push({ role: row.role === 'buyer' ? 'buyer' : 'assistant', text: text.value });
    }
    return messages;
  }

  async countTurn(
    market: MarketContext,
    id: string,
    expectedTurns: number,
    at: Temporal.Instant,
  ): Promise<boolean> {
    const counted = await this.prisma.tx(market).assistantConversation.updateMany({
      where: { marketId: market.marketId, id, turns: expectedTurns },
      data: { turns: expectedTurns + 1, lastMessageAt: dateOf(at) },
    });
    return counted.count === 1;
  }

  async append(
    market: MarketContext,
    id: string,
    message: StoredMessage & { readonly cards: readonly string[]; readonly at: Temporal.Instant },
  ): Promise<void> {
    const tx = this.prisma.tx(market);
    const last = await tx.assistantMessage.aggregate({
      where: { marketId: market.marketId, conversationId: id },
      _max: { position: true },
    });
    const cipher = await this.keys.encrypt(
      market,
      id as Id<'Conversation'>,
      MESSAGE_TEXT,
      message.text,
    );
    // The key was created with the conversation in this unit or before; destroyed only by the purge.
    if (!cipher.ok) return;
    await tx.assistantMessage.create({
      data: {
        marketId: market.marketId,
        tenantId: market.tenantId,
        conversationId: id,
        position: (last._max.position ?? 0) + 1,
        role: message.role,
        textCipher: cipher.value,
        cards: [...message.cards],
        createdAt: dateOf(message.at),
      },
    });
  }

  async datesOfAccount(
    market: MarketContext,
    accountId: Id<'Account'>,
    direction: 'asc' | 'desc',
    window: { readonly offset: number; readonly limit: number },
  ) {
    // Through the buyer list's partial (market, account, last_message_at) index, then a small sort
    // over one account's conversations; only the two instants are selected.
    const rows = await this.prisma.tx(market).assistantConversation.findMany({
      where: { marketId: market.marketId, accountId },
      orderBy: [{ startedAt: direction }, { id: direction }],
      skip: window.offset,
      take: window.limit,
      select: { startedAt: true, lastMessageAt: true },
    });
    return rows.map((row) => ({
      startedAt: Temporal.Instant.fromEpochMilliseconds(row.startedAt.getTime()),
      lastMessageAt: Temporal.Instant.fromEpochMilliseconds(row.lastMessageAt.getTime()),
    }));
  }

  countOfAccount(market: MarketContext, accountId: Id<'Account'>): Promise<number> {
    return this.prisma.tx(market).assistantConversation.count({
      where: { marketId: market.marketId, accountId },
    });
  }

  async listByAccount(
    market: MarketContext,
    accountId: Id<'Account'>,
    query: {
      readonly visibleSince: ReadonlyMap<number, Temporal.Instant>;
      readonly after: ConversationCursor | null;
      readonly limit: number;
    },
  ): Promise<ConversationListPage> {
    const open = [...query.visibleSince].filter(([days]) => days > 0);
    const windows = open.map(([days, since]) => ({
      retentionDays: days,
      lastMessageAt: { gte: dateOf(since) },
    }));
    if (windows.length === 0 || query.limit <= 0) return { rows: [], next: null };
    // The oldest window bounds the scan of the account's index entries.
    const oldest = open
      .map(([, since]) => since)
      .reduce((a, b) => (Temporal.Instant.compare(a, b) <= 0 ? a : b));
    const tx = this.prisma.tx(market);
    const { after } = query;
    const rows = await tx.assistantConversation.findMany({
      where: {
        marketId: market.marketId,
        accountId,
        lastMessageAt: { gte: dateOf(oldest) },
        AND: [
          { OR: windows },
          ...(after === null
            ? []
            : [
                {
                  OR: [
                    { lastMessageAt: { lt: dateOf(after.lastMessageAt) } },
                    { lastMessageAt: dateOf(after.lastMessageAt), id: { lt: after.id } },
                  ],
                },
              ]),
        ],
      },
      orderBy: [{ lastMessageAt: 'desc' }, { id: 'desc' }],
      // One more row than the page tells whether another page follows.
      take: query.limit + 1,
      select: { id: true, turns: true, startedAt: true, lastMessageAt: true },
    });
    const last = rows.length > query.limit ? rows[query.limit - 1] : undefined;
    const next: ConversationCursor | null =
      last === undefined ? null : { lastMessageAt: instantOf(last.lastMessageAt), id: last.id };
    rows.splice(query.limit);
    if (rows.length === 0) return { rows: [], next: null };
    // The first message of each listed conversation, in one read; each decrypts under its own key.
    const firsts = await tx.assistantMessage.findMany({
      where: {
        marketId: market.marketId,
        conversationId: { in: rows.map((row) => row.id) },
        position: 1,
        role: 'buyer',
      },
      select: { conversationId: true, textCipher: true },
    });
    const cipherOf = new Map(firsts.map((row) => [row.conversationId, row.textCipher]));
    const summaries: ConversationSummary[] = [];
    for (const row of rows) {
      const cipher = cipherOf.get(row.id);
      let firstBuyerText: string | null = null;
      if (cipher !== undefined) {
        const text = await this.keys.decrypt(
          market,
          row.id as Id<'Conversation'>,
          MESSAGE_TEXT,
          cipher,
        );
        // A destroyed key is a conversation being purged or deleted: not listed.
        if (!text.ok) continue;
        firstBuyerText = text.value;
      }
      summaries.push({
        id: row.id,
        turns: row.turns,
        startedAt: instantOf(row.startedAt),
        lastMessageAt: instantOf(row.lastMessageAt),
        firstBuyerText,
      });
    }
    return { rows: summaries, next };
  }

  async transcript(market: MarketContext, id: string): Promise<readonly TranscriptMessage[]> {
    const rows = await this.prisma.tx(market).assistantMessage.findMany({
      where: { marketId: market.marketId, conversationId: id },
      orderBy: { position: 'asc' },
      select: { position: true, role: true, textCipher: true, cards: true, createdAt: true },
    });
    const messages: TranscriptMessage[] = [];
    for (const row of rows) {
      const text = await this.keys.decrypt(
        market,
        id as Id<'Conversation'>,
        MESSAGE_TEXT,
        row.textCipher,
      );
      if (!text.ok) return [];
      messages.push({
        position: row.position,
        role: row.role === 'buyer' ? 'buyer' : 'assistant',
        text: text.value,
        cards: row.cards,
        at: instantOf(row.createdAt),
      });
    }
    return messages;
  }

  async deleteOwn(market: MarketContext, id: string, accountId: Id<'Account'>): Promise<boolean> {
    const tx = this.prisma.tx(market);
    const owned = { marketId: market.marketId, id, accountId };
    const row = await tx.assistantConversation.findFirst({
      where: owned,
      select: { retentionDays: true },
    });
    if (row === null) return false;
    const deleted = await tx.assistantConversation.deleteMany({ where: owned });
    if (deleted.count !== 1) return false;
    // The key goes with the rows, in the same unit: a backup copy of a message reads as nothing.
    if (row.retentionDays > 0) await this.keys.destroyKey(market, id as Id<'Conversation'>);
    return true;
  }

  async purgeExpired(
    market: MarketContext,
    now: Temporal.Instant,
    currentDays: { readonly customer: number; readonly guest: number },
    limit: number,
  ): Promise<number> {
    const tx = this.prisma.tx(market);
    let purged = 0;
    for (const kind of ['customer', 'guest'] as const) {
      for (const stored of STORED_RETENTIONS) {
        if (purged >= limit) return purged;
        const days = Math.max(1, Math.min(stored, currentDays[kind]));
        const expired = {
          marketId: market.marketId,
          retentionDays: stored,
          ...(kind === 'customer' ? { accountId: { not: null } } : { accountId: null }),
          lastMessageAt: { lt: new Date(now.epochMilliseconds - days * DAY_MS) },
        };
        const rows = await tx.assistantConversation.findMany({
          where: expired,
          select: { id: true },
          orderBy: { lastMessageAt: 'asc' },
          take: limit - purged,
        });
        if (rows.length === 0) continue;
        const found = rows.map((row) => row.id);
        // The cut-off is checked again by the delete: a message that landed in between keeps
        // its conversation (and its key).
        await tx.assistantConversation.deleteMany({ where: { ...expired, id: { in: found } } });
        const kept = new Set(
          (
            await tx.assistantConversation.findMany({
              where: { marketId: market.marketId, id: { in: found } },
              select: { id: true },
            })
          ).map((row) => row.id),
        );
        const ids = found.filter((id) => !kept.has(id));
        if (stored > 0) {
          for (const id of ids) await this.keys.destroyKey(market, id as Id<'Conversation'>);
        }
        purged += ids.length;
      }
    }
    return purged;
  }
}
