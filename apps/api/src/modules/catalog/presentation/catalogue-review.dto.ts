import { ApiProperty } from '@nestjs/swagger';

// The review parts of the catalogue structure routes (Admin Inbox › System requests, area
// catalogue): the note a save may carry, the review an edit opened, and what the read views say
// about whether an edit is reviewed.

export const NOTE_DESCRIPTION =
  "The admin's note for the reviewer, 1 to 500 characters; required while the Market reviews " +
  'area catalogue in Admin Inbox › System requests (else 400 on note), ignored otherwise.';

export const REQUEST_DESCRIPTION =
  'The review this edit opened in Admin Inbox › System requests; null when the Market does ' +
  'not review area catalogue or nothing changed. The edit is live at once; a rejected or ' +
  'withdrawn edit is restored.';

export class CatalogueReviewBody {
  @ApiProperty({
    description: 'An edit is reviewed in this Market: the save asks for a note.',
  })
  reviewed!: boolean;
  @ApiProperty({ enum: ['low', 'medium', 'high'] }) risk!: string;
}

export class CatalogueRequestRef {
  @ApiProperty({ format: 'uuid' }) id!: string;
  @ApiProperty({ description: 'Shown as SR-<number>.' }) number!: number;
}
