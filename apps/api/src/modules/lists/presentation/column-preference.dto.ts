import { ApiProperty } from '@nestjs/swagger';
import { MAX_PREFERRED_COLUMNS } from '../contracts';

export class ColumnPreferenceSaveRequest {
  @ApiProperty({ description: 'The list the choice belongs to, e.g. admin.catalog.products.' })
  listKey!: string;

  @ApiProperty({
    type: [String],
    description:
      `Column ids from the list's vocabulary, each once, in the order to show (at most ` +
      `${MAX_PREFERRED_COLUMNS}). An empty array shows none of the optional columns.`,
  })
  columns!: string[];
}

export class ColumnPreferenceDto {
  @ApiProperty() listKey!: string;
  @ApiProperty({
    type: [String],
    nullable: true,
    description: 'The saved ids in order; null when the caller never chose (show the default).',
  })
  columns!: string[] | null;
  @ApiProperty({ type: [String], description: 'The ids the list lets a user choose from.' })
  available!: string[];
}
