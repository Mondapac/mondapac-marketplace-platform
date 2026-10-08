import type { Id, MarketContext } from '@mondapac/shared-kernel';
import type {
  RegisterCheckRepository,
  RegisterCheckWrite,
} from '../../src/modules/sellers/application/ports/register-check.repository';
import type {
  RegisterLookupPolicy,
  RegisterLookupSettings,
} from '../../src/modules/sellers/application/ports/register-lookup-policy';
import type { TaxProfileRepository } from '../../src/modules/sellers/application/ports/tax-profile.repository';
import type {
  IdentifierIndexKey,
  IdentifierRules,
} from '../../src/modules/sellers/domain/business-identifier';
import {
  registerCheckAfter,
  type RegisterCheck,
} from '../../src/modules/sellers/domain/register-check';
import type { SellerTaxProfile } from '../../src/modules/sellers/domain/tax-registration';

// In-memory stand-ins of the slice 4a ports for suites without a database (sellers design 7.7).
// The PostgreSQL behaviour is covered by test/db/sellers-register-checks.db-spec.ts.

const keyOf = (market: MarketContext, sellerId: string, index: IdentifierIndexKey): string =>
  `${market.marketId}|${sellerId}|${Buffer.from(index).toString('hex')}`;

/** Results per (Market, seller, value); the sticky rule is the domain's `registerCheckAfter`. */
export class InMemoryRegisterChecks implements RegisterCheckRepository {
  readonly rows = new Map<string, RegisterCheck>();
  /** When set, every call rejects: a store that is down. */
  failing = false;

  find(
    market: MarketContext,
    sellerId: Id<'Seller'>,
    index: IdentifierIndexKey,
  ): Promise<RegisterCheck | null> {
    if (this.failing) return Promise.reject(new Error('register check store down'));
    return Promise.resolve(this.rows.get(keyOf(market, sellerId, index)) ?? null);
  }

  record(
    market: MarketContext,
    sellerId: Id<'Seller'>,
    index: IdentifierIndexKey,
    write: RegisterCheckWrite,
  ): Promise<RegisterCheck> {
    if (this.failing) return Promise.reject(new Error('register check store down'));
    const key = keyOf(market, sellerId, index);
    const next = registerCheckAfter(
      this.rows.get(key) ?? null,
      write.outcome,
      write.mismatches,
      write.checkedAt,
      write.checkedBy,
      write.comparedFileVersion,
    );
    this.rows.set(key, next);
    return Promise.resolve(next);
  }

  /** The rows of one Market (a test asserting that nothing was written reads this). */
  count(market: MarketContext): number {
    return [...this.rows.keys()].filter((key) => key.startsWith(`${market.marketId}|`)).length;
  }
}

/** The register-lookup values per Market; a Market not listed has no register (`none`). */
export class FixedRegisterLookupPolicy implements RegisterLookupPolicy {
  readonly #byMarket = new Map<string, RegisterLookupSettings>();

  constructor(byMarket: Readonly<Record<string, RegisterLookupSettings>> = {}) {
    for (const [code, settings] of Object.entries(byMarket)) this.#byMarket.set(code, settings);
  }

  /** Gives a Market a register (`none` removes it); for suites that boot one application. */
  set(code: string, settings: RegisterLookupSettings): void {
    if (settings.kind === 'none') this.#byMarket.delete(code);
    else this.#byMarket.set(code, settings);
  }

  settingsOf(market: MarketContext): RegisterLookupSettings {
    return this.#byMarket.get(market.marketId) ?? { kind: 'none' };
  }
}

/**
 * Valid identifiers of a scheme whose last digit is one of `last`, in increasing order and never
 * repeated, so a test can have as many distinct numbers as it needs and choose the answer the
 * `fake` adapter gives by the last digit (0 not found, 1 cancelled, 2 unavailable, else active).
 */
export function validIdentifiers(
  rules: IdentifierRules,
  length: number,
  count: number,
  last: readonly string[],
  skip = 0,
): string[] {
  const found: string[] = [];
  let seen = 0;
  for (let n = 10 ** (length - 1) + 12345; found.length < count; n += 1) {
    const text = String(n).padStart(length, '0');
    if (!last.includes(text.slice(-1)) || !rules.validate(text).ok) continue;
    seen += 1;
    if (seen > skip) found.push(text);
  }
  return found;
}

/** Tax profiles by seller, as the comparison reads them. */
export class InMemoryTaxProfiles implements TaxProfileRepository {
  readonly profiles = new Map<string, SellerTaxProfile>();

  findBySellerId(market: MarketContext, sellerId: Id<'Seller'>): Promise<SellerTaxProfile | null> {
    return Promise.resolve(this.profiles.get(`${market.marketId}|${sellerId}`) ?? null);
  }

  save(): Promise<boolean> {
    return Promise.reject(new Error('not used here'));
  }
}
