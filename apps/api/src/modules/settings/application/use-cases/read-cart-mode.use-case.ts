import { ok } from '@mondapac/shared-kernel';
import type { CallContext, Result } from '@mondapac/shared-kernel';
import { UseCase, type AccessDeclaration, type UseCaseGate } from '../../../../platform/authz';
import { CART_MODE_CODE, CART_MODE_VALUES, type CartMode } from '../../domain/definitions';
import type { SettingsDependencies } from '../settings-dependencies';
import { readSettingValue } from '../settings-flow';

/**
 * `settings.read-cart-mode`: the Market's Cart mode for another module through the settings
 * facade (the buyer assistant's cart cards first). Rule `anonymous`: the mode is how the
 * storefront behaves for every buyer, guest or signed in. A missing row is the default and an
 * unreadable store the safe value (`multi-store`, ADR-0026 decision 5); a stored value that is
 * not a known mode is also `multi-store`.
 */
export class ReadCartMode extends UseCase<Record<string, never>, CartMode, never> {
  static override readonly access: AccessDeclaration = {
    name: 'settings.read-cart-mode',
    rule: { kind: 'anonymous' },
  };

  constructor(
    gate: UseCaseGate,
    private readonly deps: SettingsDependencies,
  ) {
    super(gate);
  }

  protected async handle(context: CallContext): Promise<Result<CartMode, never>> {
    const value = await readSettingValue(this.deps, context, CART_MODE_CODE);
    return ok(
      (CART_MODE_VALUES as readonly string[]).includes(value ?? '')
        ? (value as CartMode)
        : 'multi-store',
    );
  }
}
