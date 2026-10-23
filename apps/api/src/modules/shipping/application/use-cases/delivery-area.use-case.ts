import { err, ok } from '@mondapac/shared-kernel';
import type { CallContext, Result } from '@mondapac/shared-kernel';
import { UseCase, type AccessDeclaration, type UseCaseGate } from '../../../../platform/authz';
import type { ShippingDependencies } from '../shipping-dependencies';

export type DeliveryAreaFailure = {
  readonly code: 'validation.failed';
  readonly fields: readonly { path: string; code: string }[];
};

/** A postcode as a person types it: 1 to 16 printable ASCII characters (spaces allowed). */
const POSTCODE = /^[\x20-\x7e]{1,16}$/u;

/**
 * `shipping.delivery-area`: whether the Market delivers to a postcode (ADR-0005 decision 7). The
 * answer is the ServiceArea configuration, which is public, so anyone may ask; nothing about a
 * person is read or stored. The storefront asks before checkout, and checkout asks again for the
 * chosen address.
 */
export class DeliveryArea extends UseCase<
  { readonly postcode: unknown },
  { readonly delivers: boolean },
  DeliveryAreaFailure
> {
  static override readonly access: AccessDeclaration = {
    name: 'shipping.delivery-area',
    rule: { kind: 'anonymous' },
  };

  constructor(
    gate: UseCaseGate,
    private readonly deps: ShippingDependencies,
  ) {
    super(gate);
  }

  protected handle(
    context: CallContext,
    input: { readonly postcode: unknown },
  ): Promise<Result<{ readonly delivers: boolean }, DeliveryAreaFailure>> {
    const postcode = typeof input?.postcode === 'string' ? input.postcode.trim() : '';
    if (!POSTCODE.test(postcode)) {
      return Promise.resolve(
        err({ code: 'validation.failed', fields: [{ path: 'postcode', code: 'format' }] }),
      );
    }
    return Promise.resolve(ok({ delivers: this.deps.policy.deliversTo(context.market, postcode) }));
  }
}
