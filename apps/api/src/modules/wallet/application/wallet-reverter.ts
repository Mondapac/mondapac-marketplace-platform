import type { CallContext } from '@mondapac/shared-kernel';
import type { RevertOutcome, RevertRequest, SystemChangeReverter } from '../../system-requests';
import { revertStatus } from './settings-flow';
import type { WalletDependencies } from './wallet-dependencies';
import { WALLET_SUBJECT_REF } from './wallet-review';

/** Restores the switch before a rejected or withdrawn change, in the decision's open unit. */
export class WalletStatusReverter implements SystemChangeReverter {
  constructor(private readonly deps: WalletDependencies) {}

  revert(context: CallContext, request: RevertRequest): Promise<RevertOutcome> {
    if (request.subjectRef !== WALLET_SUBJECT_REF) return Promise.resolve('gone');
    return revertStatus(this.deps, context, request);
  }
}
