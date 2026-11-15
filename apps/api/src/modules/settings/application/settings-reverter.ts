import type { CallContext } from '@mondapac/shared-kernel';
import type { RevertOutcome, RevertRequest, SystemChangeReverter } from '../../system-requests';
import type { SettingsDependencies } from './settings-dependencies';
import { revertSetting } from './settings-flow';

/**
 * The reverter settings registers for `settings.market-setting` (area marketplace): it restores a
 * Market setting when a reviewer rejects the change or its author withdraws it, in the open unit
 * of that decision.
 */
export class SettingsReverter implements SystemChangeReverter {
  constructor(private readonly deps: SettingsDependencies) {}

  revert(context: CallContext, request: RevertRequest): Promise<RevertOutcome> {
    return revertSetting(this.deps, context, request);
  }
}
