import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

// The OpenAPI shapes of the seller's draft routes (sellers design 6.2). Requests never carry a
// seller id, a Market, a state or an admin setting (AC 16): the seller is the session's, the
// Market is the request's. Bodies are closed: an unknown field is `validation.failed`.

export class SaveGeneralRequest {
  @ApiPropertyOptional({
    type: String,
    nullable: true,
    maxLength: 512,
    description:
      'The store name (the domain bound is 100 characters). Absent, null or blank: not entered.',
  })
  storeName?: string | null;

  @ApiPropertyOptional({
    type: String,
    nullable: true,
    maxLength: 512,
    description: 'The legal or business name (personal data).',
  })
  businessName?: string | null;

  @ApiPropertyOptional({
    type: String,
    nullable: true,
    maxLength: 512,
    description: 'The phone number. A first save without one is refused (phone.required).',
  })
  phone?: string | null;

  @ApiPropertyOptional({
    type: String,
    nullable: true,
    maxLength: 512,
    description: 'An optional contact email, distinct from the sign-in email.',
  })
  contactEmail?: string | null;
}

export class SaveAddressRequest {
  @ApiProperty({
    type: 'object',
    additionalProperties: { type: 'string', maxLength: 256 },
    description:
      "The operating address: the fields of the Market's address format (see form descriptors), " +
      'each a string. At most 20 fields.',
  })
  address!: Record<string, string>;

  @ApiPropertyOptional({
    type: 'object',
    nullable: true,
    additionalProperties: { type: 'string', maxLength: 256 },
    description: 'The registered address, only when it differs from the operating address.',
  })
  registeredAddress?: Record<string, string> | null;

  @ApiPropertyOptional({
    type: String,
    nullable: true,
    maxLength: 64,
    description:
      "The seller's choice of IANA zone, from the region's list (timezone.not-selectable otherwise).",
  })
  timezone?: string | null;

  @ApiPropertyOptional({
    type: String,
    nullable: true,
    maxLength: 64,
    description:
      "The browser's own IANA zone: an untrusted hint, applied only where no one set a zone.",
  })
  browserTimezone?: string | null;
}

export class CheckSlugRequest {
  @ApiProperty({
    maxLength: 100,
    description: 'The shop slug to check. Sent in the body, never in a URL.',
  })
  slug!: string;
}

export class DraftSavedBody {
  @ApiProperty({ description: "The file's version after the save." })
  version!: number;

  @ApiProperty()
  draftComplete!: boolean;

  @ApiProperty({
    type: [String],
    description: 'The mandatory parts still missing, in the order of the form.',
  })
  missing!: readonly string[];
}

class ServiceAreaBody {
  @ApiProperty()
  code!: string;

  @ApiProperty()
  sellerOnboardingEnabled!: boolean;
}

class ZoneStateBody {
  @ApiProperty({ description: 'IANA id.' })
  operatingTimezone!: string;

  @ApiProperty()
  timezoneSource!: string;

  @ApiProperty({ description: "The zone the address's region defaults to." })
  addressTimezone!: string;
}

export class AddressSavedBody extends DraftSavedBody {
  @ApiProperty({ type: ServiceAreaBody, nullable: true })
  serviceArea!: ServiceAreaBody | null;

  @ApiProperty({
    description: 'True unless the area takes new sellers; the address is kept (AC 6).',
  })
  outsideServiceArea!: boolean;

  @ApiProperty({ type: ZoneStateBody, nullable: true })
  timezone!: ZoneStateBody | null;

  @ApiProperty({
    type: [String],
    description: 'The zones the seller may choose from, the default first.',
  })
  zoneOptions!: readonly string[];
}

class GeneralView {
  @ApiProperty({ type: String, nullable: true })
  storeName!: string | null;

  @ApiProperty({ type: String, nullable: true })
  businessName!: string | null;

  @ApiProperty({ type: String, nullable: true })
  phone!: string | null;

  @ApiProperty({ type: String, nullable: true })
  contactEmail!: string | null;
}

export class MyFileBody {
  @ApiProperty()
  version!: number;

  @ApiProperty()
  draftComplete!: boolean;

  @ApiProperty({ type: [String] })
  missing!: readonly string[];

  @ApiProperty({ type: GeneralView })
  general!: GeneralView;

  @ApiProperty({
    type: 'object',
    nullable: true,
    additionalProperties: { type: 'string' },
    description: "The operating address, in the Market format's field order.",
  })
  address!: Record<string, string> | null;

  @ApiProperty({ type: 'object', nullable: true, additionalProperties: { type: 'string' } })
  registeredAddress!: Record<string, string> | null;

  @ApiProperty({ type: ServiceAreaBody, nullable: true })
  serviceArea!: ServiceAreaBody | null;

  @ApiProperty({ type: Boolean, nullable: true })
  outsideServiceArea!: boolean | null;

  @ApiProperty({ type: ZoneStateBody, nullable: true })
  timezone!: ZoneStateBody | null;

  @ApiProperty({ type: [String] })
  zoneOptions!: readonly string[];
}

export class SlugCheckBody {
  @ApiProperty({ enum: ['slug.available', 'slug.taken', 'slug.reserved', 'slug.format'] })
  code!: string;

  @ApiPropertyOptional({ description: 'The normalised slug, for slug.available only.' })
  slug?: string;
}

class AddressFieldDescriptor {
  @ApiProperty()
  key!: string;

  @ApiProperty()
  labelKey!: string;

  @ApiProperty()
  required!: boolean;

  @ApiProperty()
  maxLength!: number;
}

class AddressDescriptor {
  @ApiProperty({ type: [AddressFieldDescriptor] })
  fields!: readonly AddressFieldDescriptor[];

  @ApiProperty()
  postcodeField!: string;

  @ApiProperty({ type: String, nullable: true })
  regionField!: string | null;

  @ApiProperty({
    description: 'The anchored, bounded postcode pattern; the server checks it again.',
  })
  postcodePattern!: string;

  @ApiProperty({ type: [String] })
  regions!: readonly string[];
}

class PhoneDescriptor {
  @ApiProperty()
  maxLength!: number;
}

export class FormDescriptorsBody {
  @ApiProperty({ type: AddressDescriptor })
  address!: AddressDescriptor;

  @ApiProperty({
    type: 'object',
    additionalProperties: { type: 'array', items: { type: 'string' } },
    description: 'Per region of the address format: its zones, the default first.',
  })
  timezones!: Record<string, readonly string[]>;

  @ApiProperty({ type: PhoneDescriptor })
  phone!: PhoneDescriptor;
}

/** The error body of identity design 5.2: a code, never message text or a value. */
export class SellersErrorBody {
  @ApiProperty()
  statusCode!: number;

  @ApiProperty({ description: 'A stable code, e.g. validation.failed, file.not-found.' })
  code!: string;

  @ApiPropertyOptional({
    type: 'object',
    additionalProperties: true,
    description:
      'Closed per code: validation.failed has fields (paths and codes, never values); ' +
      'request.throttled has retryAfterSeconds.',
  })
  details?: Record<string, unknown>;
}
