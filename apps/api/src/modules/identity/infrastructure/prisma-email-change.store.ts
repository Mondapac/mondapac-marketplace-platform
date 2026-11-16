import type { Id, MarketContext, Temporal } from '@mondapac/shared-kernel';
import type { PrismaService } from '../../../platform/persistence/prisma.service';
import { fieldLabel } from '../../../platform/subject-keys/labels';
import type { SubjectKeyService } from '../../../platform/subject-keys/subject-key-service';
import type { EmailChangeStore } from '../application/ports/account.repository';

/** The label the previous address is sealed under: bound into the ciphertext. */
const PREVIOUS_EMAIL = fieldLabel('identity.account.previous-email');

const toDate = (instant: Temporal.Instant): Date => new Date(instant.epochMilliseconds);

/**
 * {@link EmailChangeStore} on `identity.accounts` (`email_change_notice`, the pending columns).
 * Every statement goes through `PrismaService.tx(market)` with `marketId` at the top of `where`.
 * The previous address is sealed with the account's subject key before it is written and opened
 * only by the notice's handler; no value is logged or returned in an error.
 */
export class PrismaEmailChangeStore implements EmailChangeStore {
  constructor(
    private readonly prisma: PrismaService,
    private readonly subjectKeys: SubjectKeyService,
  ) {}

  async keepPreviousEmail(
    market: MarketContext,
    accountId: Id<'Account'>,
    previousEmail: string,
  ): Promise<void> {
    const sealed = await this.subjectKeys.encrypt(market, accountId, PREVIOUS_EMAIL, previousEmail);
    if (!sealed.ok) throw new Error('identity.accounts: the account key is destroyed');
    await this.prisma.tx(market).identityAccount.updateMany({
      where: { marketId: market.marketId, id: accountId, population: 'customer' },
      data: { emailChangeNotice: sealed.value },
    });
  }

  async previousEmailOf(market: MarketContext, accountId: Id<'Account'>): Promise<string | null> {
    const row = await this.prisma.tx(market).identityAccount.findFirst({
      where: { marketId: market.marketId, id: accountId },
      select: { emailChangeNotice: true },
    });
    if (row === null || row.emailChangeNotice === null) return null;
    const opened = await this.subjectKeys.decrypt(
      market,
      accountId,
      PREVIOUS_EMAIL,
      row.emailChangeNotice,
    );
    return opened.ok ? opened.value : null;
  }

  async forgetPreviousEmail(market: MarketContext, accountId: Id<'Account'>): Promise<void> {
    await this.prisma.tx(market).identityAccount.updateMany({
      where: { marketId: market.marketId, id: accountId },
      data: { emailChangeNotice: null },
    });
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
