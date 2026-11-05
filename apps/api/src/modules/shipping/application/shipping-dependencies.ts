import type { Clock, IdGenerator } from '@mondapac/shared-kernel';
import type { AuditWriter } from '../../../platform/audit/audit-writer';
import type { ChangeTrail } from '../../../platform/audit/change-trail';
import type { SecurityEvents } from '../../../platform/security-events/security-events';
import type { OutboxWriter } from '../../../platform/events/outbox-writer';
import type { UnitOfWork } from '../../../platform/unit-of-work/unit-of-work';
import type { CarrierBookingRepository } from './ports/carrier-booking.repository';
import type { CarrierPolicy } from './ports/carrier-policy';
import type { CarrierWebhookSignature } from './ports/carrier-webhook-signature';
import type { FleetWebhookSignature } from './ports/fleet-webhook-signature';
import type { DeliverySettingsRepository } from './ports/delivery-settings.repository';
import type { FleetRegistry } from './ports/fleet-registry';
import type { FleetSelectionRepository } from './ports/fleet-selection.repository';
import type { DeliveryQuoteRepository } from './ports/delivery-quote.repository';
import type { FleetLedgerRepository } from './ports/fleet-ledger.repository';
import type { PickupDirectory } from './ports/pickup-directory';
import type { SellerDirectory } from './ports/seller-directory';
import type { ShippingPolicy } from './ports/shipping-policy';

/** What every shipping use case may need; one object built from the same ports. */
export interface ShippingDependencies {
  readonly unitOfWork: UnitOfWork;
  readonly policy: ShippingPolicy;
  readonly sellers: SellerDirectory;
  readonly audit: AuditWriter;
  readonly clock: Clock;
  readonly ids: IdGenerator;
  readonly outbox: OutboxWriter;
  readonly bookings: CarrierBookingRepository;
  readonly fleets: FleetRegistry;
  readonly selection: FleetSelectionRepository;
  readonly deliverySettings: DeliverySettingsRepository;
  readonly carrierPolicy: CarrierPolicy;
  /** The delivery quotes shown to buyers and charged at checkout. */
  readonly quotes: DeliveryQuoteRepository;
  /** The fees fleets charge the platform and the bookings that replaced the charged fleet. */
  readonly ledger: FleetLedgerRepository;
  readonly pickups: PickupDirectory;
  readonly webhookSignature: CarrierWebhookSignature;
  /** Uber Direct's status webhook signature (one header, no timestamp). */
  readonly uberWebhookSignature: FleetWebhookSignature;
  readonly securityEvents: SecurityEvents;
  /** "Last changed by" and the history of the admin settings pages, from this module's audit rows. */
  readonly trail: ChangeTrail;
}
