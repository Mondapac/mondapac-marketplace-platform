import { ApiProperty } from '@nestjs/swagger';

// Bodies of the in-app notice routes. A notice carries no text: the panel renders it from `kind`
// and `params`, and builds the link to the item (the seller order) from the same fields.

export class NoticeParamsBody {
  @ApiProperty({ format: 'uuid', description: 'seller.order-paid: the seller order (the link).' })
  sellerOrderId!: string;
  @ApiProperty({ description: 'seller.order-paid: the number of items in the seller order.' })
  items!: number;
}

export class NoticeBody {
  @ApiProperty({ format: 'uuid' })
  id!: string;
  @ApiProperty({ enum: ['seller.order-paid'] })
  kind!: string;
  @ApiProperty({ type: NoticeParamsBody })
  params!: NoticeParamsBody;
  @ApiProperty({ format: 'date-time' })
  createdAt!: string;
  @ApiProperty({ description: 'Whether the signed-in member has read it.' })
  read!: boolean;
}

export class ListedNoticeBody extends NoticeBody {
  @ApiProperty({
    nullable: true,
    type: String,
    description:
      'seller.order-paid: the customer\'s short name ("Maryam R."), read now, never stored. Null ' +
      'without identity.customer-short-name.view, when the customer gave no name, or when the ' +
      'lookup failed. Personal data: render as text, do not cache.',
  })
  customerShortName!: string | null;
}

export class NoticePageBody {
  @ApiProperty({ type: [ListedNoticeBody], description: 'Newest first, at most 20.' })
  items!: ListedNoticeBody[];
  @ApiProperty({
    nullable: true,
    type: String,
    format: 'uuid',
    description: 'The `before` of the next page; null on the last page.',
  })
  next!: string | null;
}

export class UnreadNoticesBody {
  @ApiProperty()
  unread!: number;
  @ApiProperty({
    type: NoticeBody,
    nullable: true,
    description: 'The newest unread notice, so the panel can tell a new one arrived.',
  })
  newest!: NoticeBody | null;
}

export class NoticesMarkedBody {
  @ApiProperty({ description: 'How many notices became read by this call.' })
  marked!: number;
}
