import { ApiProperty } from '@nestjs/swagger';
import type {
  ShippingRequestRef,
  ShippingReview,
} from '../application/use-cases/view-delivery-settings.use-case';

// The review parts of the delivery routes (Admin Inbox › System requests, area delivery).

export const NOTE_DESCRIPTION =
  "The admin's note for the reviewer, 1 to 500 characters; required while the Market reviews " +
  'area delivery in Admin Inbox › System requests (else 400 on note), ignored otherwise.';

export class DeliveryReviewBody {
  @ApiProperty({
    description: 'A change is reviewed in this Market: the save asks for a note.',
  })
  reviewed!: boolean;
  @ApiProperty({ enum: ['low', 'medium', 'high'] }) risk!: string;
}

export class DeliveryRequestRef {
  @ApiProperty({ format: 'uuid' }) id!: string;
  @ApiProperty({ description: 'Shown as SR-<number>.' }) number!: number;
}

export const REQUEST_DESCRIPTION =
  'The review this change opened in Admin Inbox › System requests; null when the Market does ' +
  'not review area delivery or nothing changed.';

export const reviewBody = (review: ShippingReview): DeliveryReviewBody => ({
  reviewed: review.reviewed,
  risk: review.risk,
});

export const requestBody = (request: ShippingRequestRef): DeliveryRequestRef | null =>
  request === null ? null : { id: request.id, number: request.number };
