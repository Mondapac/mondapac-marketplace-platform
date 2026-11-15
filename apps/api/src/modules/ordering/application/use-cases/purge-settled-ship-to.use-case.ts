import type { CallContext } from '@mondapac/shared-kernel';
import { UseCase, type AccessDeclaration, type UseCaseGate } from '../../../../platform/authz';
import {
  purgeSettledShipTo,
  type ShipToPurgeRun,
  type ShipToRetentionDependencies,
} from '../ship-to-retention-flow';

/**
 * Clears the sealed ship-to of orders settled longer ago than the Market's retention, when an
 * admin switched it on (owner decision 2026-11-15). Rule `system`: only the worker's job
 * `ordering.purge-settled-ship-to` calls it.
 */
export class PurgeSettledShipTo extends UseCase<Record<string, never>, ShipToPurgeRun, never> {
  static override readonly access: AccessDeclaration = {
    name: 'ordering.purge-settled-ship-to',
    rule: { kind: 'system' },
  };

  constructor(
    gate: UseCaseGate,
    private readonly deps: ShipToRetentionDependencies,
  ) {
    super(gate);
  }

  protected handle(context: CallContext) {
    return purgeSettledShipTo(this.deps, context);
  }
}
