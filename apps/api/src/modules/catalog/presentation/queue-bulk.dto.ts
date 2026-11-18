import { ApiProperty } from '@nestjs/swagger';

export class BulkDecideItemRequest {
  @ApiProperty({ format: 'uuid' }) id!: string;
  @ApiProperty({ description: 'The row version the list showed; a changed row is skipped.' })
  version!: number;
}

export class BulkDecideRequest {
  @ApiProperty({ description: 'The decision: `approve` and `decline` or `reject`, per queue.' })
  action!: string;
  @ApiProperty({ type: [BulkDecideItemRequest], description: '1 to 50 rows, no id twice.' })
  items!: BulkDecideItemRequest[];
  @ApiProperty({
    required: false,
    description: 'Needed by a reject or decline (not by an approve).',
  })
  reason?: string;
  @ApiProperty({
    required: false,
    description: 'Category proposals: the reject reason code (instead of `reason`).',
  })
  reasonCode?: string;
  @ApiProperty({ required: false, enum: ['occasion', 'cuisine', 'use'] }) group?: string;
}

export class BulkDecideResultBody {
  @ApiProperty({ format: 'uuid' }) id!: string;
  @ApiProperty({ enum: ['done', 'skipped', 'failed'] }) outcome!: string;
  @ApiProperty({ required: false, description: 'A stable code of why the row was not decided.' })
  reason?: string;
}

export class BulkDecideCountsBody {
  @ApiProperty() done!: number;
  @ApiProperty() skipped!: number;
  @ApiProperty() failed!: number;
}

export class BulkDecideBody {
  @ApiProperty() action!: string;
  @ApiProperty({ type: BulkDecideCountsBody }) counts!: BulkDecideCountsBody;
  @ApiProperty({ type: [BulkDecideResultBody], description: 'Every row, in the order given.' })
  results!: BulkDecideResultBody[];
}
