import { err, ok, Temporal } from '@mondapac/shared-kernel';
import type { Id, MarketContext, Result } from '@mondapac/shared-kernel';
import type { PrismaService } from '../../../../platform/persistence/prisma.service';
import type {
  ExternalIdentity,
  ExternalIdentityRepository,
} from '../../application/ports/external-identity.repository';
import {
  SIGN_IN_PROVIDERS,
  type SignInProviderName,
} from '../../application/ports/sign-in-providers';

/** The unique keys an insert can meet: the subject, or the account's provider. */
const TAKEN = new Set([
  'external_identities_pkey',
  'external_identities_market_id_account_id_provider_key',
]);

const SELECTED = { accountId: true, provider: true, subject: true, createdAt: true } as const;

interface SelectedRow {
  readonly accountId: string;
  readonly provider: string;
  readonly subject: string;
  readonly createdAt: Date;
}

/**
 * {@link ExternalIdentityRepository} on `identity.external_identities`. Every statement goes
 * through `PrismaService.tx(market)` with `marketId` at the top level of `where` (P 4); a unique
 * violation becomes `identity.taken`, nothing of the driver error is logged or returned (I15).
 */
export class PrismaExternalIdentityRepository implements ExternalIdentityRepository {
  constructor(private readonly prisma: PrismaService) {}

  async findBySubject(
    market: MarketContext,
    provider: SignInProviderName,
    subject: string,
  ): Promise<ExternalIdentity | null> {
    const row = await this.prisma.tx(market).identityExternalIdentity.findFirst({
      where: { marketId: market.marketId, provider, subject },
      select: SELECTED,
    });
    return row === null ? null : restore(row);
  }

  async findForAccount(
    market: MarketContext,
    accountId: Id<'Account'>,
    provider: SignInProviderName,
  ): Promise<ExternalIdentity | null> {
    const row = await this.prisma.tx(market).identityExternalIdentity.findFirst({
      where: { marketId: market.marketId, accountId, provider },
      select: SELECTED,
    });
    return row === null ? null : restore(row);
  }

  async add(
    market: MarketContext,
    identity: ExternalIdentity,
  ): Promise<Result<void, { readonly code: 'identity.taken' }>> {
    try {
      await this.prisma.tx(market).identityExternalIdentity.create({
        data: {
          marketId: market.marketId,
          tenantId: market.tenantId,
          provider: identity.provider,
          subject: identity.subject,
          accountId: identity.accountId,
          createdAt: new Date(identity.createdAt.epochMilliseconds),
        },
        select: { accountId: true },
      });
      return ok(undefined);
    } catch (error) {
      const constraint = this.prisma.violatedConstraint(error);
      if (constraint !== null && TAKEN.has(constraint)) return err({ code: 'identity.taken' });
      throw error;
    }
  }
}

function restore(row: SelectedRow): ExternalIdentity {
  if (!(SIGN_IN_PROVIDERS as readonly string[]).includes(row.provider)) {
    throw new Error('identity.external_identities: a stored provider is unknown');
  }
  return {
    accountId: row.accountId as Id<'Account'>,
    provider: row.provider as SignInProviderName,
    subject: row.subject,
    createdAt: Temporal.Instant.fromEpochMilliseconds(row.createdAt.getTime()),
  };
}
