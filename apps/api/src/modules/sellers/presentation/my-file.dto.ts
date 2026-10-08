import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { REVISION_AUTHOR_KINDS, WITHDRAW_CAUSES } from '../domain/revision-kinds';
import { SELLER_STATUSES } from '../domain/seller-status';

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

export class SaveSlugRequest {
  @ApiProperty({
    maxLength: 100,
    description: 'The shop slug to save in the draft. Sent in the body, never in a URL.',
  })
  slug!: string;
}

export class SaveIdentifierRequest {
  @ApiPropertyOptional({
    type: String,
    nullable: true,
    maxLength: 128,
    description:
      "The business number in the Market's scheme, as typed (spaces and hyphens allowed). Absent, " +
      'null or blank clears the saved one. Sent in the body, never in a URL (personal data).',
  })
  identifier?: string | null;
}

export class CheckIdentifierRequest {
  @ApiProperty({
    maxLength: 128,
    description: 'The business number to check. Sent in the body, never in a URL.',
  })
  identifier!: string;
}

export class IdentifierCheckBody {
  @ApiProperty({ description: "How people write the number in the Market's scheme." })
  display!: string;
}

export class DraftSavedBody {
  @ApiProperty({ description: "The file's version after the save." })
  version!: number;

  @ApiProperty()
  draftComplete!: boolean;

  @ApiProperty({
    type: [String],
    enum: ['storeName', 'businessName', 'phone', 'address', 'timezone', 'identifier', 'slug'],
    description: 'The mandatory parts still missing, in the order of the form.',
  })
  missing!: readonly string[];

  @ApiProperty({
    description:
      'True when this save withdrew the pending submission (an edit of a submitted file does): ' +
      'the seller must submit again.',
  })
  submissionWithdrawn!: boolean;
}

/** What the register said, as the seller may see it (brief s5): never a register value. */
const REGISTER_RESULTS = ['matched', 'not-matched', 'could-not-be-checked'] as const;

/** The answer of `PUT my-file/identifier`: a draft save and the register result of the number. */
export class IdentifierSavedBody extends DraftSavedBody {
  @ApiProperty({
    type: String,
    enum: REGISTER_RESULTS,
    nullable: true,
    description:
      'What the official register said about the saved number: matched, not-matched (one ' +
      'message for not found and cancelled) or could-not-be-checked (a reviewer will check). ' +
      'Null when the Market has no register lookup, the number was cleared or no current result ' +
      'exists. Never a register value, never "verified".',
  })
  registerResult!: (typeof REGISTER_RESULTS)[number] | null;
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

class IdentifierView {
  @ApiProperty({ description: 'The normalised value.' })
  value!: string;

  @ApiProperty({ description: 'How people write it in the scheme.' })
  display!: string;
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

class OnboardingStepBody {
  @ApiProperty({ enum: ['sellers'] })
  owningModule!: string;

  @ApiProperty({ description: 'Translation key, e.g. sellers.steps.business.' })
  titleKey!: string;

  @ApiProperty({ enum: ['done', 'to-do', 'waiting', 'needs-attention'] })
  state!: string;

  @ApiProperty({ type: Number, nullable: true })
  fieldsLeft!: number | null;
}

class SubmissionBody {
  @ApiProperty()
  revisionNo!: number;

  @ApiProperty({ description: 'ISO 8601 instant (UTC).' })
  submittedAt!: string;
}

class WithdrawalBody {
  @ApiProperty({ enum: WITHDRAW_CAUSES })
  cause!: string;

  @ApiProperty({ enum: REVISION_AUTHOR_KINDS })
  byKind!: string;

  @ApiProperty({ description: 'ISO 8601 instant (UTC).' })
  at!: string;
}

export class SubmittedBody extends SubmissionBody {
  @ApiProperty({ description: "The file's version after the submission." })
  version!: number;

  @ApiProperty({ description: 'The file had an earlier revision: another try, not a first one.' })
  resubmission!: boolean;
}

export class WithdrawnBody {
  @ApiProperty({ description: "The file's version after the withdrawal." })
  version!: number;
}

export class MyFileBody {
  @ApiProperty()
  version!: number;

  @ApiProperty()
  draftComplete!: boolean;

  @ApiProperty({
    type: [String],
    enum: ['storeName', 'businessName', 'phone', 'address', 'timezone', 'identifier', 'slug'],
  })
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

  @ApiProperty({
    type: String,
    nullable: true,
    description: 'The shop slug chosen in the draft (clear, not public while a draft).',
  })
  slug!: string | null;

  @ApiProperty({
    type: () => IdentifierView,
    nullable: true,
    description:
      "The saved business number of the Market's scheme (personal data), or null. A number of " +
      'a scheme the Market no longer uses is not shown and does not count.',
  })
  identifier!: IdentifierView | null;

  @ApiProperty({
    type: String,
    enum: REGISTER_RESULTS,
    nullable: true,
    description:
      'What the official register said about the saved number: matched, not-matched or ' +
      'could-not-be-checked; null when the Market has no register lookup, no number is saved ' +
      'or no current result exists. Never a register value.',
  })
  registerResult!: (typeof REGISTER_RESULTS)[number] | null;

  @ApiProperty({ type: [String] })
  zoneOptions!: readonly string[];

  @ApiProperty({
    type: String,
    enum: SELLER_STATUSES,
    description:
      'The one status of the file (design 3.3). A rejected seller reads changes-needed until ' +
      'the re-apply limit arrives with a later slice.',
  })
  status!: string;

  @ApiProperty({
    type: () => [OnboardingStepBody],
    description: 'The steps card of the home page, in order; the client maps titleKey to its page.',
  })
  onboardingSteps!: readonly OnboardingStepBody[];

  @ApiProperty({ type: () => SubmissionBody, nullable: true })
  submission!: SubmissionBody | null;

  @ApiProperty({
    type: () => WithdrawalBody,
    nullable: true,
    description: 'The latest revision when it ended withdrawn: why, by whom and when.',
  })
  latestWithdrawal!: WithdrawalBody | null;
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

class IdentifierDescriptor {
  @ApiProperty({ description: "The scheme code of the Market's configuration." })
  scheme!: string;

  @ApiProperty({ description: 'Translation key of the field label.' })
  labelKey!: string;

  @ApiProperty({ description: 'Whether a complete draft needs the number in this Market.' })
  required!: boolean;

  @ApiProperty({ description: 'The most a person may type; the server checks the scheme.' })
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

  @ApiProperty({ type: IdentifierDescriptor })
  identifier!: IdentifierDescriptor;
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
      'request.throttled and lookup.limit have retryAfterSeconds.',
  })
  details?: Record<string, unknown>;
}
