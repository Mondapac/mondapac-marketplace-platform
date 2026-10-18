import { ApiProperty } from '@nestjs/swagger';
import type { AddressView } from '../application/use-cases/create-address.use-case';
import type { AddressBookView } from '../application/use-cases/list-addresses.use-case';

// Bodies of the address book routes. Personal data goes only to its own customer.

export class AddressRequest {
  @ApiProperty({ maxLength: 60, example: 'Aisha' }) recipientFirstName!: string;
  @ApiProperty({ maxLength: 60, example: 'Rahman' }) recipientLastName!: string;
  @ApiProperty({
    example: '0412 345 678',
    description: 'For delivery only. Spaces, hyphens, dots and brackets are removed.',
  })
  phone!: string;
  @ApiProperty({ maxLength: 120, example: '12 Example Street' }) line1!: string;
  @ApiProperty({ required: false, nullable: true, type: String, maxLength: 120 })
  line2?: string | null;
  @ApiProperty({ maxLength: 80, example: 'Sunnybank' }) suburb!: string;
  @ApiProperty({
    required: false,
    nullable: true,
    type: String,
    example: 'QLD',
    description: "One of the Market's regions; required when the Market has regions.",
  })
  region?: string | null;
  @ApiProperty({ example: '4109', description: "Must match the Market's postcode pattern." })
  postcode!: string;
  @ApiProperty({ required: false, nullable: true, type: String, maxLength: 250 })
  deliveryNotes?: string | null;
  @ApiProperty({
    required: false,
    description: 'true also makes it the default address; false never clears the default.',
  })
  isDefault?: boolean;
}

export class AddressBody {
  @ApiProperty({ format: 'uuid' }) id!: string;
  @ApiProperty() recipientFirstName!: string;
  @ApiProperty() recipientLastName!: string;
  @ApiProperty() phone!: string;
  @ApiProperty() line1!: string;
  @ApiProperty({ nullable: true, type: String }) line2!: string | null;
  @ApiProperty() suburb!: string;
  @ApiProperty({ nullable: true, type: String }) region!: string | null;
  @ApiProperty() postcode!: string;
  @ApiProperty({ description: "ISO 3166 country (the Market's address country)." })
  countryCode!: string;
  @ApiProperty({ nullable: true, type: String }) deliveryNotes!: string | null;
  @ApiProperty() isDefault!: boolean;
  @ApiProperty({ format: 'date-time' }) createdAt!: string;
  @ApiProperty({ format: 'date-time' }) updatedAt!: string;
}

export class AddressBookBody {
  @ApiProperty({
    type: [AddressBody],
    description: 'The default address first, then newest first.',
  })
  addresses!: AddressBody[];
  @ApiProperty({ description: 'The most addresses the book may hold in this Market.' })
  limit!: number;
}

export class DeletedBody {
  @ApiProperty({ enum: [true] }) deleted!: true;
}

export const addressBody = (view: AddressView): AddressBody => ({
  id: view.id,
  recipientFirstName: view.recipientFirstName,
  recipientLastName: view.recipientLastName,
  phone: view.phone,
  line1: view.line1,
  line2: view.line2,
  suburb: view.suburb,
  region: view.region,
  postcode: view.postcode,
  countryCode: view.countryCode,
  deliveryNotes: view.deliveryNotes,
  isDefault: view.isDefault,
  createdAt: view.createdAt.toString(),
  updatedAt: view.updatedAt.toString(),
});

export const addressBookBody = (view: AddressBookView): AddressBookBody => ({
  addresses: view.addresses.map(addressBody),
  limit: view.limit,
});
