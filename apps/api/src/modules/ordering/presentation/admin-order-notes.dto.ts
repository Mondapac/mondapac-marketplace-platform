import { ApiProperty } from '@nestjs/swagger';
import type { AdminNoteView } from '../application/use-cases/admin-order-notes.use-case';
import { NOTE_MAX_LENGTH } from '../domain/admin-order-note';

export class AdminNoteRequestBody {
  @ApiProperty({
    description: `Plain text, 1 to ${NOTE_MAX_LENGTH} characters after trimming; line breaks kept.`,
  })
  body!: string;
}

export class AdminNoteBody {
  @ApiProperty({ format: 'uuid' }) noteId!: string;
  @ApiProperty({
    type: String,
    nullable: true,
    description:
      "Plain text written by an admin: render it escaped. Null when the customer's account " +
      'was erased (the text is gone with their key).',
  })
  body!: string | null;
  @ApiProperty({ format: 'uuid' }) authorAccountId!: string;
  @ApiProperty({
    type: String,
    nullable: true,
    description: "The author's display name; null when unknown.",
  })
  authorName!: string | null;
  @ApiProperty({ description: 'Whether the asking admin wrote it.' }) byYou!: boolean;
  @ApiProperty({ format: 'date-time' }) createdAt!: string;
}

export class AdminNoteListBody {
  @ApiProperty({ type: [AdminNoteBody], description: 'Newest first, at most 100.' })
  notes!: AdminNoteBody[];
}

export const NOTE_BODY_KEYS = ['body'] as const;

export const adminNoteBody = (note: AdminNoteView): AdminNoteBody => ({
  noteId: note.noteId,
  body: note.body,
  authorAccountId: note.authorAccountId,
  authorName: note.authorName,
  byYou: note.byYou,
  createdAt: note.createdAt.toString(),
});
