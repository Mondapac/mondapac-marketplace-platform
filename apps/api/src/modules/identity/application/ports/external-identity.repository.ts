import type { Id, MarketContext, Result, Temporal } from '@mondapac/shared-kernel';
import type { SignInProviderName } from './sign-in-providers';

/** A customer account's identity at a sign-in provider (social sign-in). */
export interface ExternalIdentity {
  readonly accountId: Id<'Account'>;
  readonly provider: SignInProviderName;
  readonly subject: string;
  readonly createdAt: Temporal.Instant;
}

/**
 * `identity.external_identities`: one row per (Market, provider, subject), and at most one per
 * account and provider. Rows go with their account (cascade); nothing else changes them.
 */
export interface ExternalIdentityRepository {
  findBySubject(
    market: MarketContext,
    provider: SignInProviderName,
    subject: string,
  ): Promise<ExternalIdentity | null>;
  findForAccount(
    market: MarketContext,
    accountId: Id<'Account'>,
    provider: SignInProviderName,
  ): Promise<ExternalIdentity | null>;
  /** `identity.taken`: the subject, or this account's provider, already has a row. */
  add(
    market: MarketContext,
    identity: ExternalIdentity,
  ): Promise<Result<void, { readonly code: 'identity.taken' }>>;
}

/** Nest token of the {@link ExternalIdentityRepository}. */
export const EXTERNAL_IDENTITY_REPOSITORY = Symbol('EXTERNAL_IDENTITY_REPOSITORY');
