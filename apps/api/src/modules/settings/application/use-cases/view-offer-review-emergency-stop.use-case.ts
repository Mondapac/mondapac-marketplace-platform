import { err, ok } from '@mondapac/shared-kernel';
import type { CallContext, Result, Temporal } from '@mondapac/shared-kernel';
import { UseCase, type AccessDeclaration, type UseCaseGate } from '../../../../platform/authz';
import { OFFER_REVIEW_EMERGENCY_STOP_CODE } from '../../domain/definitions';
import type { AdminNames } from '../ports/admin-names';
import type { SettingsDependencies } from '../settings-dependencies';
import type { SettingsFailure } from '../settings-flow';

export interface OfferReviewEmergencyStopView {
  readonly on: boolean;
  /** For the change call; 0 while the default is in force. */
  readonly version: number;
  /** When it was last switched, null while the default is in force. */
  readonly changedAt: Temporal.Instant | null;
  /** The display name of the admin who last switched it, null when unknown. */
  readonly changedBy: string | null;
}

export interface ViewOfferReviewEmergencyStopDependencies {
  readonly settings: SettingsDependencies;
  readonly names: AdminNames;
}

/**
 * `settings.view-offer-review-emergency-stop` (R0, design 9.5 b): any admin of the Market reads
 * whether the Offer review emergency stop is on, since when and who switched it, for the banner on
 * every admin page. Rule `own-resources` limited to the admin population; a seller or a customer
 * is refused (the seller only ever sees "in review").
 */
export class ViewOfferReviewEmergencyStop extends UseCase<
  Record<string, never>,
  OfferReviewEmergencyStopView,
  SettingsFailure
> {
  static override readonly access: AccessDeclaration = {
    name: 'settings.view-offer-review-emergency-stop',
    rule: { kind: 'own-resources' },
    // Admins only (checked below); a seller is refused whatever its state.
    whenSellerNotApproved: 'deny',
  };

  constructor(
    gate: UseCaseGate,
    private readonly deps: ViewOfferReviewEmergencyStopDependencies,
  ) {
    super(gate);
  }

  protected async handle(
    context: CallContext,
  ): Promise<Result<OfferReviewEmergencyStopView, SettingsFailure>> {
    const { actor } = context;
    if (actor.kind !== 'authenticated' || actor.population !== 'admin') {
      return err({ code: 'access.denied' });
    }
    const { settings } = this.deps;
    const row = await settings.unitOfWork.run(
      context.market,
      async () =>
        ok(await settings.settings.find(context.market, OFFER_REVIEW_EMERGENCY_STOP_CODE)),
      { readOnly: true },
    );
    if (!row.ok) return err({ code: 'access.denied' });
    // Only an exact `on` is on; a missing or unreadable value is the default `off`.
    const record = row.value;
    const names =
      record === null
        ? new Map<string, string>()
        : await this.deps.names.namesOf(context, [record.updatedBy]);
    return ok({
      on: record?.value === 'on',
      version: record?.version ?? 0,
      changedAt: record?.updatedAt ?? null,
      changedBy: record === null ? null : (names.get(record.updatedBy) ?? null),
    });
  }
}
