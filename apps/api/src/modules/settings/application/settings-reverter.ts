import type { CallContext } from '@mondapac/shared-kernel';
import type { RevertOutcome, RevertRequest, SystemChangeReverter } from '../../system-requests';
import { findDefinition } from '../domain/definitions';
import type { SettingsDependencies } from './settings-dependencies';
import { revertSetting } from './settings-flow';

/**
 * The reverter settings registers for `settings.market-setting` (area marketplace): it restores a
 * Market setting when a reviewer rejects the change or its author withdraws it, in the open unit
 * of that decision. Its `describe` names each setting by its definition (no read).
 */
export class SettingsReverter implements SystemChangeReverter {
  constructor(private readonly deps: SettingsDependencies) {}

  revert(context: CallContext, request: RevertRequest): Promise<RevertOutcome> {
    return revertSetting(this.deps, context, request);
  }

  describe(_context: CallContext, subjectRefs: readonly string[]) {
    const labels = new Map<string, string>();
    for (const ref of subjectRefs) {
      const definition = findDefinition(ref);
      if (definition !== null) labels.set(ref, definition.label);
    }
    return Promise.resolve(labels as ReadonlyMap<string, string>);
  }
}
