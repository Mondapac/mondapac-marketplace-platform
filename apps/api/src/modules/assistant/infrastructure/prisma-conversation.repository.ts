import { Temporal } from '@mondapac/shared-kernel';
import type { Id, MarketContext } from '@mondapac/shared-kernel';
import type { PrismaService } from '../../../platform/persistence/prisma.service';
import { fieldLabel } from '../../../platform/subject-keys/labels';
import type { SubjectKeyService } from '../../../platform/subject-keys/subject-key-service';
import type {
  ConversationOwner,
  ConversationRecord,
  ConversationRepository,
  StoredMessage,
} from '../application/ports/conversation.repository';

/** The label bound into every message ciphertext (PF 4 row 3). */
const MESSAGE_TEXT = fieldLabel('assistant.message.text');

/** The retention values a conversation can store (the table's CHECK). */
const STORED_RETENTIONS = [0, 30, 365] as const;

const DAY_MS = 24 * 60 * 60 * 1000;

const dateOf = (instant: Temporal.Instant): Date => new Date(instant.epochMilliseconds);

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

  async find(market: MarketContext, id: string): Promise<ConversationRecord | null> {
    const row = await this.prisma.tx(market).assistantConversation.findFirst({
      where: { marketId: market.marketId, id },
      select: { id: true, accountId: true, guestTokenHash: true, turns: true, retentionDays: true },
    });
    if (row === null) return null;
    const owner: ConversationOwner =
      row.accountId !== null
        ? { kind: 'account', accountId: row.accountId as Id<'Account'> }
        : { kind: 'guest', tokenHash: Buffer.from(row.guestTokenHash!).toString('hex') };
    return { id: row.id, owner, turns: row.turns, retentionDays: row.retentionDays };
  }

  async create(
    market: MarketContext,
    conversation: ConversationRecord & { readonly startedAt: Temporal.Instant },
  ): Promise<boolean> {
    const { owner } = conversation;
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
        const rows = await tx.assistantConversation.findMany({
          where: {
            marketId: market.marketId,
            retentionDays: stored,
            ...(kind === 'customer' ? { accountId: { not: null } } : { accountId: null }),
            lastMessageAt: { lt: new Date(now.epochMilliseconds - days * DAY_MS) },
          },
          select: { id: true },
          orderBy: { lastMessageAt: 'asc' },
          take: limit - purged,
        });
        if (rows.length === 0) continue;
        const ids = rows.map((row) => row.id);
        await tx.assistantConversation.deleteMany({
          where: { marketId: market.marketId, id: { in: ids } },
        });
        if (stored > 0) {
          for (const id of ids) await this.keys.destroyKey(market, id as Id<'Conversation'>);
        }
        purged += ids.length;
      }
    }
    return purged;
  }
}
