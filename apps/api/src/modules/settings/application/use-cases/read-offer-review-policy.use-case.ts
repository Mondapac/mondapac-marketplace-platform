import { ok } from '@mondapac/shared-kernel';
import type { CallContext, Result } from '@mondapac/shared-kernel';
import { UseCase, type AccessDeclaration, type UseCaseGate } from '../../../../platform/authz';
import {
  findDefinition,
  OFFER_REVIEW_BADGES_CODE,
  OFFER_REVIEW_MODE_CODE,
  OFFER_REVIEW_PRICE_BAND_CODE,
  OFFER_REVIEW_PROBATION_CODE,
  OFFER_REVIEW_REFERENCE_SELLERS_CODE,
  OFFER_REVIEW_SAMPLING_CODE,
  type OfferReviewBadges,
  type OfferReviewMode,
} from '../../domain/definitions';
import type { SettingsDependencies } from '../settings-dependencies';
import { readSettingValue } from '../settings-flow';

/** The Market's Offer review policy as `catalog` and `pricing` use it (ADR-0051). */
export interface OfferReviewPolicySettings {
  readonly mode: OfferReviewMode;
  readonly probationOffers: number;
  readonly referenceSellers: number;
  /** Percent above or below the reference. */
  readonly priceBandPercent: number;
  /** Percent of automatically published Offers checked afterwards. */
  readonly samplingPercent: number;
  readonly certificateBadges: OfferReviewBadges;
}

const safeOf = (code: string): string => findDefinition(code)?.safeValue ?? '';

/** The safe policy (every Offer waits), for a facade whose read failed or threw. */
export const SAFE_OFFER_REVIEW_POLICY: OfferReviewPolicySettings = Object.freeze({
  mode: safeOf(OFFER_REVIEW_MODE_CODE) as OfferReviewMode,
  probationOffers: Number(safeOf(OFFER_REVIEW_PROBATION_CODE)),
  referenceSellers: Number(safeOf(OFFER_REVIEW_REFERENCE_SELLERS_CODE)),
  priceBandPercent: Number(safeOf(OFFER_REVIEW_PRICE_BAND_CODE)),
  samplingPercent: Number(safeOf(OFFER_REVIEW_SAMPLING_CODE)),
  certificateBadges: safeOf(OFFER_REVIEW_BADGES_CODE) as OfferReviewBadges,
});

/**
 * `settings.read-offer-review-policy`: the six Offer review settings of the Market, for `catalog`
 * (and later `pricing`) through the settings facade. Rule `anonymous`: a seller's or an admin's
 * request reads it (the gate reads it as an anonymous actor of the same Market) and none of it is
 * secret. The system actor is refused by the gate, so a job reading through the facade gets the safe
 * policy; a job that needs the stored values needs a `system` variant first (Hassan S2). Each value is the stored one when the
 * definition still allows it, else the safe value (readSettingValue), so the answer is always one
 * the definitions allow.
 */
export class ReadOfferReviewPolicy extends UseCase<
  Record<string, never>,
  OfferReviewPolicySettings,
  never
> {
  static override readonly access: AccessDeclaration = {
    name: 'settings.read-offer-review-policy',
    rule: { kind: 'anonymous' },
  };

  constructor(
    gate: UseCaseGate,
    private readonly deps: SettingsDependencies,
  ) {
    super(gate);
  }

  protected async handle(context: CallContext): Promise<Result<OfferReviewPolicySettings, never>> {
    const read = async (code: string) =>
      (await readSettingValue(this.deps, context, code)) ?? safeOf(code);
    return ok({
      mode: (await read(OFFER_REVIEW_MODE_CODE)) as OfferReviewMode,
      probationOffers: Number(await read(OFFER_REVIEW_PROBATION_CODE)),
      referenceSellers: Number(await read(OFFER_REVIEW_REFERENCE_SELLERS_CODE)),
      priceBandPercent: Number(await read(OFFER_REVIEW_PRICE_BAND_CODE)),
      samplingPercent: Number(await read(OFFER_REVIEW_SAMPLING_CODE)),
      certificateBadges: (await read(OFFER_REVIEW_BADGES_CODE)) as OfferReviewBadges,
    });
  }
}
