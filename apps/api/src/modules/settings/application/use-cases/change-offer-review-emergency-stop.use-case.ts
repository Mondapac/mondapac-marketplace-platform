import { err } from '@mondapac/shared-kernel';
import type { CallContext, Result } from '@mondapac/shared-kernel';
import { UseCase, type AccessDeclaration, type UseCaseGate } from '../../../../platform/authz';
import { SETTINGS_OFFER_REVIEW_EMERGENCY_STOP } from '../../contracts/permissions';
import { OFFER_REVIEW_EMERGENCY_STOP_CODE } from '../../domain/definitions';
import type { SettingsDependencies } from '../settings-dependencies';
import { changeSettings, type SettingChangeView, type SettingsFailure } from '../settings-flow';

interface Input {
  /** `on` or `off`. */
  readonly value?: unknown;
  /** The version the admin saw (0 while the default is in force). */
  readonly expectedVersion?: unknown;
  /** Why: always required, 1 to 500 characters, kept with the change and its review. */
  readonly note?: unknown;
}

/** The longest reason the stop takes (the settings note limit). */
const MAX_NOTE = 500;

/**
 * `settings.change-offer-review-emergency-stop` (R0, design 9.5 b): an admin holding the
 * protected key switches the Market's Offer review emergency stop on or off. A reason is always
 * required, whether or not the Market reviews settings changes; the change is live at once,
 * audited, and reviewed at high risk afterwards where the area is reviewed. A stale version is a
 * conflict. Nothing switches it off by itself.
 */
export class ChangeOfferReviewEmergencyStop extends UseCase<
  Input,
  readonly SettingChangeView[],
  SettingsFailure
> {
  static override readonly access: AccessDeclaration = {
    name: 'settings.change-offer-review-emergency-stop',
    rule: { kind: 'permissions', allOf: [SETTINGS_OFFER_REVIEW_EMERGENCY_STOP.key] },
  };

  constructor(
    gate: UseCaseGate,
    private readonly deps: SettingsDependencies,
  ) {
    super(gate);
  }

  protected handle(
    context: CallContext,
    input: Input,
  ): Promise<Result<readonly SettingChangeView[], SettingsFailure>> {
    const note = typeof input?.note === 'string' ? input.note.trim() : '';
    if (note.length === 0 || note.length > MAX_NOTE) {
      return Promise.resolve(
        err({ code: 'validation.failed', fields: [{ path: 'note', code: 'required' }] }),
      );
    }
    return changeSettings(this.deps, context, [OFFER_REVIEW_EMERGENCY_STOP_CODE], {
      changes: [
        {
          code: OFFER_REVIEW_EMERGENCY_STOP_CODE,
          value: input.value,
          expectedVersion: input.expectedVersion,
        },
      ],
      note,
    });
  }
}
