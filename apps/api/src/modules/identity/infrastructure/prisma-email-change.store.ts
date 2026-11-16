import type { Id, MarketContext, Temporal } from '@mondapac/shared-kernel';
import type { PrismaService } from '../../../platform/persistence/prisma.service';
import { fieldLabel } from '../../../platform/subject-keys/labels';
import type { SubjectKeyService } from '../../../platform/subject-keys/subject-key-service';
import type { EmailChangeNotice, EmailChangeStore } from '../application/ports/account.repository';

/** The labels the two addresses of a notice are sealed under: bound into each ciphertext. */
const PREVIOUS_EMAIL = fieldLabel('identity.email-change-notice.previous-email');
const NEW_EMAIL = fieldLabel('identity.email-change-notice.new-email');

const toDate = (instant: Temporal.Instant): Date => new Date(instant.epochMilliseconds);

/**
 * {@link EmailChangeStore} on `identity.email_change_notices` (one row per confirmed change) and
 * the pending columns of `identity.accounts`. Every statement goes through
 * `PrismaService.tx(market)` with `marketId` at the top of `where`. Both addresses are sealed
 * with the account's subject key before they are written and opened only by the notice's
 * handler; no value is logged or returned in an error.
 */
export class PrismaEmailChangeStore implements EmailChangeStore {
  constructor(
    private readonly prisma: PrismaService,
    private readonly subjectKeys: SubjectKeyService,
  ) {}

  async recordNotice(
    market: MarketContext,
    accountId: Id<'Account'>,
    accountVersion: number,
    notice: EmailChangeNotice,
    now: Temporal.Instant,
  ): Promise<void> {
    const previous = await this.subjectKeys.encrypt(
      market,
      accountId,
      PREVIOUS_EMAIL,
      notice.previousEmail,
    );
    const next = await this.subjectKeys.encrypt(market, accountId, NEW_EMAIL, notice.newEmail);
    if (!previous.ok || !next.ok)
      throw new Error('identity.accounts: the account key is destroyed');
    await this.prisma.tx(market).identityEmailChangeNotice.create({
      data: {
        marketId: market.marketId,
        tenantId: market.tenantId,
        accountId,
        accountVersion,
        previousEmail: previous.value,
        newEmail: next.value,
        createdAt: toDate(now),
      },
    });
  }

  async noticeOf(
    market: MarketContext,
    accountId: Id<'Account'>,
    accountVersion: number,
  ): Promise<EmailChangeNotice | 'missing' | 'unreadable'> {
    const row = await this.prisma.tx(market).identityEmailChangeNotice.findFirst({
      where: { marketId: market.marketId, accountId, accountVersion },
      select: { previousEmail: true, newEmail: true },
    });
    if (row === null) return 'missing';
    const previous = await this.subjectKeys.decrypt(
      market,
      accountId,
      PREVIOUS_EMAIL,
      row.previousEmail,
    );
    const next = await this.subjectKeys.decrypt(market, accountId, NEW_EMAIL, row.newEmail);
    if (!previous.ok || !next.ok) return 'unreadable';
    return { previousEmail: previous.value, newEmail: next.value };
  }

  async forgetNotice(
    market: MarketContext,
    accountId: Id<'Account'>,
    accountVersion: number,
  ): Promise<boolean> {
    const { count } = await this.prisma.tx(market).identityEmailChangeNotice.deleteMany({
      where: { marketId: market.marketId, accountId, accountVersion },
    });
    return count === 1;
  }

  async clearLapsedPendingEmails(market: MarketContext, before: Temporal.Instant): Promise<number> {
    // One set-based statement with a version step per row, so a concurrent request (a newer
    // instant) or confirmation (the version it read) of the same account wins or loses as a whole.
    const { count } = await this.prisma.tx(market).identityAccount.updateMany({
      where: {
        marketId: market.marketId,
        pendingEmailRequestedAt: { lte: toDate(before) },
      },
      data: {
        pendingEmail: null,
        pendingEmailNormalized: null,
        pendingEmailRequestedAt: null,
        version: { increment: 1 },
      },
    });
    return count;
  }
}
