import type { CallContext } from '@mondapac/shared-kernel';
import { UseCase, type AccessDeclaration, type UseCaseGate } from '../../../../platform/authz';
import type { ExportFile } from '../../../../platform/list-export';
import { COMMISSION_PAYOUTS_EARNINGS_VIEW } from '../../contracts/permissions';
import {
  exportOwnPayouts,
  type OwnPayoutExportFailure,
  type OwnPayoutListDependencies,
} from '../own-payout-list-flow';

type Input = Readonly<Record<string, unknown>>;

/**
 * `commission-payouts.export-own-payouts`: the signed-in seller downloads its payouts. A bulk
 * file of money rows needs `commission-payouts.earnings.view` (as the seller's ledger does); the
 * seller id is always the session's.
 */
export class ExportOwnPayouts extends UseCase<Input, ExportFile, OwnPayoutExportFailure> {
  static override readonly access: AccessDeclaration = {
    name: 'commission-payouts.export-own-payouts',
    rule: { kind: 'permissions', allOf: [COMMISSION_PAYOUTS_EARNINGS_VIEW.key] },
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
