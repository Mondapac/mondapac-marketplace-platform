import type { Clock, IdGenerator } from '@mondapac/shared-kernel';
import type { AuditWriter } from '../../../platform/audit/audit-writer';
import type { OutboxWriter } from '../../../platform/events/outbox-writer';
import type { UnitOfWork } from '../../../platform/unit-of-work/unit-of-work';
import type { CarrierBookingRepository } from './ports/carrier-booking.repository';
import type { CarrierGateway } from './ports/carrier-gateway';
import type { CarrierPolicy } from './ports/carrier-policy';
import type { CarrierWebhookSignature } from './ports/carrier-webhook-signature';
import type { FlatFeeRepository } from './ports/flat-fee.repository';
import type { PickupDirectory } from './ports/pickup-directory';
import type { SellerDirectory } from './ports/seller-directory';
import type { ShippingPolicy } from './ports/shipping-policy';

/** What every shipping use case may need; one object built from the same ports. */
export interface ShippingDependencies {
  readonly unitOfWork: UnitOfWork;
  readonly fees: FlatFeeRepository;
  readonly policy: ShippingPolicy;
  readonly sellers: SellerDirectory;
  readonly audit: AuditWriter;
  readonly clock: Clock;
  readonly ids: IdGenerator;
  readonly outbox: OutboxWriter;
  readonly bookings: CarrierBookingRepository;
  readonly carrier: CarrierGateway;
  readonly carrierPolicy: CarrierPolicy;
  readonly pickups: PickupDirectory;
  readonly webhookSignature: CarrierWebhookSignature;
}
