import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { SELLER_STATUSES } from '../domain/seller-status';
import {
  LIST_DEFAULT_LIMIT,
  LIST_KINDS,
  LIST_MAX_LIMIT,
  LIST_TABS,
  SEARCH_MAX_LENGTH,
  SEARCH_MIN_LENGTH,
} from '../domain/seller-list';

/**
 * The request of the admin seller list (sellers design 7.8; SEL-14). A POST body, so a search
 * term never sits in a URL, an access log or a referrer. Closed: any other field is
 * `validation.failed`.
 */
export class SellerListRequest {
  @ApiPropertyOptional({
    enum: LIST_TABS,
    default: 'awaiting-review',
    description:
      'The tab, read from the sellers module. Only these three tabs are served. The tabs that ' +
      'follow the access state of identity (changes needed, not approved, approved, ' +
      'suspended) are not yet available: they are not modelled as empty lists, and a request ' +
      'for one is validation.failed.',
  })
  tab?: (typeof LIST_TABS)[number];

  @ApiPropertyOptional({
    enum: LIST_KINDS,
    description: 'Awaiting review only: a new application or a change request.',
  })
  kind?: (typeof LIST_KINDS)[number];

  @ApiPropertyOptional({
    description:
      'Incomplete only: files whose saved address is outside every area that takes new sellers.',
  })
  outsideArea?: boolean;

  @ApiPropertyOptional({
    minLength: SEARCH_MIN_LENGTH,
    maxLength: SEARCH_MAX_LENGTH,
    description:
      'A prefix of the store name, and of the shop slug when it has only slug characters. ' +
      'Never a business number. A term that names too many sellers is search.too-broad.',
  })
  search?: string;

  @ApiPropertyOptional({
    description:
      'The `next` of the previous page, for the same tab. Pass it back unchanged; it is not ' +
      'signed and carries no secret.',
  })
  after?: string;

  @ApiPropertyOptional({
    minimum: 1,
    maximum: LIST_MAX_LIMIT,
    default: LIST_DEFAULT_LIMIT,
    description: 'Rows per page.',
  })
  limit?: number;
}

/** One row of the admin list: clear fields only, no business data and no personal field. */
export class SellerListRowView {
  @ApiProperty({ description: 'The seller id (UUID v7).' })
  sellerId!: string;

  @ApiProperty({ type: String, nullable: true })
  storeName!: string | null;

  @ApiProperty({
    type: String,
    nullable: true,
    description: 'The held shop slug, else the slug of the draft; null before one is chosen.',
  })
  slug!: string | null;

  @ApiProperty({
    type: String,
    enum: [...SELLER_STATUSES, 'hidden'],
    nullable: true,
    description:
      'The status of the seller file. `hidden` when the caller does not also hold ' +
      'identity.seller-access.view (the status shows the access state identity owns); null ' +
      'when identity does not know the seller.',
  })
  status!: string | null;

  @ApiProperty({ enum: ['self', 'invitation'] })
  origin!: 'self' | 'invitation';

  @ApiProperty({
    type: String,
    enum: LIST_KINDS,
    nullable: true,
    description: 'The kind of the pending submission; null when none is pending.',
  })
  kind!: string | null;

  @ApiProperty({
    type: String,
    nullable: true,
    description: 'ISO instant the pending submission was made.',
  })
  submittedAt!: string | null;

  @ApiProperty({ type: String, nullable: true })
  serviceAreaCode!: string | null;

  @ApiProperty({ type: String, nullable: true, description: 'IANA zone id of the seller.' })
  timezone!: string | null;

  @ApiProperty({ description: 'ISO instant.' })
  createdAt!: string;

  @ApiProperty({ description: 'ISO instant of the latest change of the file.' })
  lastChangedAt!: string;
}

export class SellerListAwaitingCounts {
  @ApiProperty()
  onboarding!: number;

  @ApiProperty()
  identityChange!: number;
}

export class SellerListCounts {
  @ApiProperty({ type: SellerListAwaitingCounts })
  awaitingReview!: SellerListAwaitingCounts;

  @ApiProperty()
  incomplete!: number;

  @ApiProperty()
  all!: number;
}

export class SellerListBody {
  @ApiProperty({ enum: LIST_TABS })
  tab!: (typeof LIST_TABS)[number];

  @ApiProperty({ type: [SellerListRowView] })
  items!: SellerListRowView[];

  @ApiProperty({
    type: String,
    nullable: true,
    description: 'Send as `after` for the next page; null after the last page.',
  })
  next!: string | null;

  @ApiProperty({ type: SellerListCounts })
  counts!: SellerListCounts;
}
