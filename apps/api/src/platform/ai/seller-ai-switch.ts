import type { CallContext, Id } from '@mondapac/shared-kernel';

/**
 * The seller's AI switch (SEL-25), owned by `sellers` and evaluated here (ADR-0019 decision 7):
 * `platform/ai` declares this port and `sellers` implements it, so `platform/` imports no module.
 * It is bound in the composition root (`AiModule.register`); unbound, boot fails in both roles.
 *
 * It takes the caller's context unchanged: the `sellers` query behind it is open to every actor
 * (requests and the system actor alike), so the answer never depends on who asks. Only an
 * explicit "on" is on; the gateway treats a throw as off. This file calls no model, so `sellers`
 * may import it.
 */
export interface SellerAiSwitch {
  isOn(context: CallContext, sellerId: Id<'Seller'>): Promise<boolean>;
}

export const SELLER_AI_SWITCH = Symbol('SELLER_AI_SWITCH');
