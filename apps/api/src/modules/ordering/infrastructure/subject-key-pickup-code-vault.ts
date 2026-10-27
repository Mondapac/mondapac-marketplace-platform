import { randomInt } from 'node:crypto';
import { err, ok } from '@mondapac/shared-kernel';
import type { Id, MarketContext } from '@mondapac/shared-kernel';
import { fieldLabel, hashPurpose } from '../../../platform/subject-keys/labels';
import type { SubjectKeyService } from '../../../platform/subject-keys/subject-key-service';
import type { PickupCodeVault } from '../application/ports/pickup-code-vault';
import { newPickupCode, type RandomInt } from '../domain/pickup-code';

/** The label the sealed pickup code is bound to (platform subject keys, PF 4 row 3). */
export const PICKUP_CODE_LABEL = fieldLabel('ordering.pickup-code.code');
/** The purpose of the keyed hash of a pickup code: a hash under another purpose never matches. */
export const PICKUP_CODE_PURPOSE = hashPurpose('ordering.pickup-code');

const csprng: RandomInt = (maxExclusive) => randomInt(maxExclusive);

/**
 * {@link PickupCodeVault} on the platform `SubjectKeyService` (PF 4): the subject is the buyer's
 * account, whose key `identity` created with the account. No new secret is configured: the keys
 * are the account's own data key, wrapped under the Region Stack's wrapping key. The code is
 * drawn with `crypto.randomInt` (a CSPRNG, uniform, no modulo bias). Both the hash and the sealed
 * copy carry the seller order id, so a value copied to another seller order does not verify.
 */
export class SubjectKeyPickupCodeVault implements PickupCodeVault {
  constructor(
    private readonly keys: SubjectKeyService,
    private readonly random: RandomInt = csprng,
  ) {}

  async issue(market: MarketContext, accountId: Id<'Account'>, sellerOrderId: Id<'SellerOrder'>) {
    const code = newPickupCode(this.random);
    const hash = await this.digest(market, accountId, sellerOrderId, code);
    if (!hash.ok) return err(hash.error);
    const sealed = await this.keys.encrypt(
      market,
      accountId,
      PICKUP_CODE_LABEL,
      `${sellerOrderId}:${code}`,
    );
    if (!sealed.ok) return err(sealed.error);
    return ok({ code, hash: hash.value, sealed: sealed.value });
  }

  digest(
    market: MarketContext,
    accountId: Id<'Account'>,
    sellerOrderId: Id<'SellerOrder'>,
    code: string,
  ) {
    return this.keys.hmac(
      market,
      accountId,
      PICKUP_CODE_PURPOSE,
      new TextEncoder().encode(`${sellerOrderId}:${code}`),
    );
  }

  async reveal(
    market: MarketContext,
    accountId: Id<'Account'>,
    sellerOrderId: Id<'SellerOrder'>,
    sealed: string,
  ) {
    const opened = await this.keys.decrypt(market, accountId, PICKUP_CODE_LABEL, sealed);
    if (!opened.ok) return err(opened.error);
    const prefix = `${sellerOrderId}:`;
    // Only this vault seals the value: a different shape is damage, never a code to show.
    if (!opened.value.startsWith(prefix)) throw new Error('ordering.stored-pickup-code-invalid');
    return ok(opened.value.slice(prefix.length));
  }
}
