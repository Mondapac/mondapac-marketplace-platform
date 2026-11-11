import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

// The requests and answers of the attribute import (attributes plan, package A9).

export class AttributeImportCheckRequest {
  @ApiPropertyOptional({
    description:
      'The file name as the browser sent it. It is only a label and is never echoed or stored. The ' +
      'format is read from the content, not from the name.',
  })
  fileName?: string;

  @ApiProperty({
    description:
      'The file as standard base64 text: a CSV file (UTF-8, comma-separated, a header row) or an ' +
      'XLSX workbook (first worksheet, no formulas), at most 10 MiB and 5,000 rows. An attributes ' +
      'file has the columns of the attributes export (`code`, `type`, `name[<locale>]`, ...); a ' +
      'values file has `attribute_code`, `value_code`, `active` and `label[<locale>]`.',
  })
  data!: string;
}

export class AttributeImportRunRequest extends AttributeImportCheckRequest {
  @ApiProperty({
    description: 'The `fileSha256` the check answered. The run applies only that file.',
  })
  fileSha256!: string;

  @ApiPropertyOptional({
    description: 'true runs the file although some rows are errors; they are skipped.',
  })
  skipErrors?: boolean;
}

export class ImportIssueDto {
  @ApiProperty() column!: string;
  @ApiProperty() code!: string;
}

export class ImportChangeDto {
  @ApiProperty() field!: string;
  @ApiProperty() before!: string;
  @ApiProperty() after!: string;
}

export class ImportPlannedRowDto {
  @ApiProperty() rowNumber!: number;
  @ApiProperty({ description: 'The attribute code, or attribute/value in a values file.' })
  key!: string;
  @ApiProperty({ enum: ['create', 'update', 'unchanged', 'error'] }) action!: string;
  @ApiProperty({ type: [ImportChangeDto] }) changes!: ImportChangeDto[];
  @ApiProperty({ type: [ImportIssueDto] }) issues!: ImportIssueDto[];
}

export class ImportCountsDto {
  @ApiProperty() rows!: number;
  @ApiProperty() create!: number;
  @ApiProperty() update!: number;
  @ApiProperty() unchanged!: number;
  @ApiProperty() errors!: number;
}

export class AttributeImportCheckBody {
  @ApiProperty({ enum: ['attributes', 'values'] }) kind!: string;
  @ApiProperty({ type: ImportCountsDto }) counts!: ImportCountsDto;
  @ApiProperty({ description: 'Hex SHA-256 of the file; send it back to run exactly this file.' })
  fileSha256!: string;
  @ApiProperty({ type: [String], description: 'Headers of the file that were not read.' })
  ignoredColumns!: string[];
  @ApiProperty() canRun!: boolean;
  @ApiProperty({
    type: [ImportPlannedRowDto],
    description: 'Errors first, then changes; at most 200.',
  })
  rows!: ImportPlannedRowDto[];
  @ApiProperty() truncated!: boolean;
}

export class ImportReportFileDto {
  @ApiProperty() filename!: string;
  @ApiProperty() contentType!: string;
  @ApiProperty({ description: 'The report as standard base64 text.' }) data!: string;
}

export class ImportResultRowDto {
  @ApiProperty() rowNumber!: number;
  @ApiProperty() key!: string;
  @ApiProperty({ enum: ['created', 'updated', 'unchanged', 'skipped', 'failed'] }) result!: string;
  @ApiProperty({ nullable: true, type: String }) code!: string | null;
}

export class AttributeImportRunBody {
  @ApiProperty({ enum: ['attributes', 'values'] }) kind!: string;
  @ApiProperty() rows!: number;
  @ApiProperty() created!: number;
  @ApiProperty() updated!: number;
  @ApiProperty() unchanged!: number;
  @ApiProperty() skipped!: number;
  @ApiProperty() failed!: number;
  @ApiProperty({ type: [ImportResultRowDto], description: 'Failed and skipped rows; at most 200.' })
  results!: ImportResultRowDto[];
  @ApiProperty() truncated!: boolean;
  @ApiProperty({ type: ImportReportFileDto }) report!: ImportReportFileDto;
}
