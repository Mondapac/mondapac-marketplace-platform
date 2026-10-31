import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  IMPORT_JOB_STATES,
  START_AS,
  STOP_REASONS,
} from '../domain/platform-import/platform-import-job';

// The requests and answers of the admin platform import (catalog design 14a).

export class PlatformImportCheckRequest {
  @ApiProperty({
    description:
      'The file name as the browser sent it. It is only a label: it is cleaned to letters, digits and ' +
      '. _ ( ) - and spaces, never echoed as sent and never part of a path. The type of the file is ' +
      'read from its content, not from the name.',
  })
  fileName?: string;

  @ApiProperty({
    description:
      'The file as standard base64 text: a CSV file (UTF-8, comma-separated, a header row), at most ' +
      '10 MiB and 5,000 rows, at most 10,000 characters a cell.',
  })
  data!: string;
}

export class PlatformImportStartRequest {
  @ApiProperty({ enum: START_AS, description: 'The status new products start in.' })
  startAs!: string;

  @ApiProperty({
    description:
      'true leaves out the rows with errors. A file with errors is confirmed only with true.',
  })
  skipErrors!: boolean;
}

export class ImportColumnDto {
  @ApiProperty() key!: string;
  @ApiProperty() header!: string;
  @ApiProperty() required!: boolean;
}

export class PlatformImportTemplateDto {
  @ApiProperty({ type: [ImportColumnDto] }) columns!: ImportColumnDto[];
  @ApiProperty({ type: [String] }) typesOffered!: string[];
  @ApiProperty({ type: Object }) limits!: { rows: number; fileBytes: number };
  @ApiProperty() filename!: string;
  @ApiProperty({ description: 'The template file as CSV text.' }) csv!: string;
}

export class ImportErrorLineDto {
  @ApiProperty() rowNumber!: number;
  @ApiProperty() column!: string;
  @ApiProperty() code!: string;
  @ApiProperty() value!: string;
  @ApiProperty({ nullable: true, type: Number }) otherRow!: number | null;
}

export class ImportFailureLineDto {
  @ApiProperty() rowNumber!: number;
  @ApiProperty() title!: string;
  @ApiProperty() code!: string;
}

export class ImportPreviewRowDto {
  @ApiProperty() rowNumber!: number;
  @ApiProperty() title!: string;
  @ApiProperty() category!: string;
  @ApiProperty() typeCode!: string;
  @ApiProperty() brand!: string;
}

export class IgnoredColumnDto {
  @ApiProperty() header!: string;
  @ApiProperty() certification!: boolean;
}

export class PlatformImportDto {
  @ApiProperty({ format: 'uuid' }) id!: string;
  @ApiProperty({ enum: IMPORT_JOB_STATES }) state!: string;
  @ApiProperty() fileLabel!: string;
  @ApiProperty() fileBytes!: number;
  @ApiProperty({ enum: ['csv', 'xlsx'] }) format!: string;
  @ApiProperty() rows!: number;
  @ApiProperty() ready!: number;
  @ApiProperty() errors!: number;
  @ApiProperty() warnings!: number;
  @ApiProperty({ type: [IgnoredColumnDto] }) ignoredColumns!: IgnoredColumnDto[];
  @ApiProperty({ enum: START_AS, nullable: true, type: String }) startAs!: string | null;
  @ApiProperty({ nullable: true, type: Boolean }) skipErrors!: boolean | null;
  @ApiProperty({ nullable: true, type: Number }) toImport!: number | null;
  @ApiProperty() added!: number;
  @ApiProperty() failed!: number;
  @ApiProperty({ enum: STOP_REASONS, nullable: true, type: String }) stopReason!: string | null;
  @ApiProperty() canResume!: boolean;
  @ApiProperty() checkedAt!: string;
  @ApiProperty({ nullable: true, type: String }) startedAt!: string | null;
  @ApiProperty({ nullable: true, type: String }) finishedAt!: string | null;
  @ApiProperty({ nullable: true, type: Number }) durationSeconds!: number | null;
  @ApiProperty({ type: [ImportErrorLineDto], description: 'At most 100; the report has all.' })
  errorLines!: ImportErrorLineDto[];
  @ApiProperty({ type: [ImportFailureLineDto], description: 'At most 100; the report has all.' })
  failureLines!: ImportFailureLineDto[];
  @ApiProperty({ type: [ImportPreviewRowDto], description: 'The first five ready rows.' })
  preview!: ImportPreviewRowDto[];
}

export class PlatformImportCurrentDto {
  @ApiPropertyOptional({ type: PlatformImportDto, nullable: true })
  import!: PlatformImportDto | null;
}

export class PlatformImportDiscardedDto {
  @ApiProperty() discarded!: boolean;
}
