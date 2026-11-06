import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import type { Id, MarketContext } from '@mondapac/shared-kernel';
import type { HandoverCodes } from '../../application/ports/handover-codes';
import { HANDOVER_CODE_LENGTH, handoverCodeFromRandom } from '../../domain/handover-code';

/** The label that derives the code key from the stack secret (its own label, as the tag's). */
const KEY_LABEL = 'mondapac.identity.agent-handover-code.v1';

/**
 * {@link HandoverCodes}: codes from the system random source; HMAC-SHA-256 under a key derived
 * from the stack secret of identity design 6.8 with its own label, over a JSON array of the Market,
 * the invitation and the code, so no two inputs share a message. The key and the code are never
 * logged.
 */
export class HmacHandoverCodes implements HandoverCodes {
  readonly #key: Buffer;

  constructor(stackSecret: Uint8Array) {
    if (stackSecret.length !== 32) throw new TypeError('The stack secret is 32 bytes');
    this.#key = createHmac('sha256', stackSecret).update(KEY_LABEL).digest();
  }

  issue(): string {
    return handoverCodeFromRandom(randomBytes(HANDOVER_CODE_LENGTH));
  }

  hmacOf(
    market: MarketContext,
    invitationId: Id<'Invitation'>,
    normalisedCode: string,
  ): Uint8Array {
    return new Uint8Array(
      createHmac('sha256', this.#key)
        .update(JSON.stringify([market.marketId, invitationId, normalisedCode]))
        .digest(),
    );
  }

  matches(
    market: MarketContext,
    invitationId: Id<'Invitation'>,
    normalisedCode: string,
    stored: Uint8Array,
  ): boolean {
    const expected = this.hmacOf(market, invitationId, normalisedCode);
    return stored.length === expected.length && timingSafeEqual(stored, expected);
  }
}
