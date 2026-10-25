import { Logger } from '@nestjs/common';
import type { CallContext, Clock, Money } from '@mondapac/shared-kernel';
import type { AuditWriter } from '../../../../platform/audit/audit-writer';
import type { UnitOfWork } from '../../../../platform/unit-of-work/unit-of-work';
import type { DeliveryTerms, DeliveryTermsRefusal } from '../../domain/delivery-terms';
import type { MinimumOrderRefusal, MinimumOrderRule } from '../../domain/minimum-order';
import type {
  AccessUnavailable,
  DraftAccessDenied,
  RequestThrottled,
  SellersUnavailable,
} from '../draft/draft-support';
import type { DraftConflict, DraftValidationFailed, FileNotFound } from '../draft/draft-view';
import type { MinimumOrderPolicy } from '../ports/minimum-order-policy';
import type { RateCounterKeys } from '../ports/rate-counter-keys';
import type { RateCounterRepository } from '../ports/rate-counter.repository';
import type { StoreProfileRepository } from '../ports/store-profile.repository';

// What the two store-settings use cases share (sellers design 18; slice 20): their view, their
// failures and dependencies, and two small helpers. Both are seller-scope use cases under
// `sellers.store-settings.edit`, for approved sellers only; the seller is always
// `ActorContext.sellerId`, never an id from the request.

/** What the settings page shows: the saved value, the version a save must name, the Market's bounds. */
export interface StoreSettingsView {
  /** The version a save must name as `expectedVersion`. */
  readonly version: number;
  /** As stored; null is "no minimum". */
  readonly minimumOrder: Money | null;
  /** The Market currency a minimum is entered in. */
  readonly currency: string;
  /** The largest amount, in minor units of that currency. */
  readonly maximumAmount: bigint;
  /** As stored; null is "no delivery terms set". */
  readonly delivery: DeliveryTerms | null;
}

export type StoreSettingsFailure =
  DraftAccessDenied | AccessUnavailable | SellersUnavailable | FileNotFound;

export type MinimumOrderSaveFailure =
  | StoreSettingsFailure
  | DraftValidationFailed
  | MinimumOrderRefusal
  | RequestThrottled
  | DraftConflict;

export type DeliverySaveFailure =
  | StoreSettingsFailure
  | DraftValidationFailed
  | DeliveryTermsRefusal
  | RequestThrottled
  | DraftConflict;

export interface StoreSettingsDependencies {
  readonly unitOfWork: UnitOfWork;
  readonly storeProfiles: StoreProfileRepository;
  readonly minimumOrderPolicy: MinimumOrderPolicy;
}

export interface MinimumOrderSaveDependencies extends StoreSettingsDependencies {
  readonly audit: AuditWriter;
  readonly counters: RateCounterRepository;
  readonly counterKeys: RateCounterKeys;
  readonly clock: Clock;
}

export const storeSettingsLogger = new Logger('SellerStoreSettings');

/** The Market's rule, or null when the Market has none or its configuration cannot be read. */
export const ruleOf = (
  policy: MinimumOrderPolicy,
  context: CallContext,
): MinimumOrderRule | null => {
  try {
    return policy.rule(context.market);
  } catch {
    return null;
  }
};

export const sameMoney = (a: Money | null, b: Money | null): boolean =>
  a === null || b === null ? a === b : a.amount === b.amount && a.currency === b.currency;
