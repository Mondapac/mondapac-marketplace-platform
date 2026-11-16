import type { CallContext } from '@mondapac/shared-kernel';
import { UseCase, type AccessDeclaration, type UseCaseGate } from '../../../../platform/authz';
import type { ExportFile } from '../../../../platform/list-export';
import {
  exportOwnPayouts,
  type OwnPayoutExportFailure,
  type OwnPayoutListDependencies,
} from '../own-payout-list-flow';

type Input = Readonly<Record<string, unknown>>;

/** `commission-payouts.export-own-payouts`: the signed-in seller downloads its payouts (own resources). */
export class ExportOwnPayouts extends UseCase<Input, ExportFile, OwnPayoutExportFailure> {
  static override readonly access: AccessDeclaration = {
    name: 'commission-payouts.export-own-payouts',
    rule: { kind: 'own-resources' },
    whenSellerNotApproved: 'allow',
  };

  constructor(
    gate: UseCaseGate,
    private readonly deps: OwnPayoutListDependencies,
  ) {
    super(gate);
  }

  protected handle(context: CallContext, input: Input) {
    return exportOwnPayouts(this.deps, context, input);
  }
}
