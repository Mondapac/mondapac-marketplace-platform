import { ApiProperty } from '@nestjs/swagger';
import type { WorkQueueAnswer } from '../application/use-cases/view-admin-work-queue.use-case';

export class WorkQueueItemBody {
  @ApiProperty({ description: '`<module>.<queue>`; the panel maps it to its label and link.' })
  key!: string;
  @ApiProperty({ enum: ['critical', 'today', 'review'] }) level!: string;
  @ApiProperty({
    enum: ['ok', 'error'],
    description:
      '`error`: the queue failed or took longer than 1.5 s; show "Couldn\'t load", never 0.',
  })
  status!: string;
  @ApiProperty({ required: false, description: 'Only when status is ok.' }) count?: number;
  @ApiProperty({ required: false, description: 'Part of count. Only when status is ok.' })
  overdue?: number;
  @ApiProperty({
    required: false,
    nullable: true,
    type: String,
    format: 'date-time',
    description: 'When the item that has waited longest came in; null when unknown or empty.',
  })
  oldestAt?: string | null;
  @ApiProperty({
    required: false,
    format: 'date-time',
    description: 'When this count was made (a count may be up to 60 s old; live queues never are).',
  })
  countedAt?: string;
}

export class WorkQueueBody {
  @ApiProperty({ enum: ['admin', 'seller'] }) panel!: string;
  @ApiProperty({ format: 'date-time' }) generatedAt!: string;
  @ApiProperty({
    type: [WorkQueueItemBody],
    description:
      'Critical first, then today, then review; within a level in a fixed order. A queue the ' +
      'viewer holds no key for is absent.',
  })
  queues!: WorkQueueItemBody[];
}

export function workQueueBody(answer: WorkQueueAnswer): WorkQueueBody {
  return {
    panel: answer.panel,
    generatedAt: answer.generatedAt.toString(),
    queues: answer.queues.map((item) =>
      item.status === 'ok'
        ? {
            key: item.key,
            level: item.level,
            status: item.status,
            count: item.count,
            overdue: item.overdue,
            oldestAt: item.oldestAt === null ? null : item.oldestAt.toString(),
            countedAt: item.countedAt.toString(),
          }
        : { key: item.key, level: item.level, status: item.status },
    ),
  };
}
