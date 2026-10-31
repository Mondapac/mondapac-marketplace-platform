import { ApiProperty } from '@nestjs/swagger';
import type { ChangeByKind } from './change-trail';

// Swagger bodies of "last changed" and the history of a settings page (see change-trail.ts).

export class LastChangedDto {
  @ApiProperty({ example: '2026-10-30T09:15:00.000Z', description: 'When the page last changed.' })
  at!: string;
  @ApiProperty({
    nullable: true,
    type: String,
    description:
      'The display name of who changed it (never an email or an id); null for a system change, ' +
      'for Mondapac staff seen by a seller, and for someone who can no longer be named.',
  })
  byDisplayName!: string | null;
  @ApiProperty({
    enum: ['member', 'platform', 'system'],
    description:
      'member: a person of your own side (an admin for an admin, your team for a seller). ' +
      'platform: Mondapac staff, seen by a seller. system: a job or the platform.',
  })
  byKind!: ChangeByKind;
}

export class ChangeHistoryItemDto extends LastChangedDto {
  @ApiProperty({ description: 'The id of the change; also the cursor of the next page.' })
  id!: string;
  @ApiProperty({
    type: [String],
    description:
      'Names of the fields that changed, never their values. Empty when the change does not say.',
  })
  fields!: string[];
}

export class ChangeHistoryDto {
  @ApiProperty({ type: [ChangeHistoryItemDto], description: 'Newest first.' })
  items!: ChangeHistoryItemDto[];
  @ApiProperty({ nullable: true, type: String, description: 'The `after` of the next page.' })
  next!: string | null;
}
