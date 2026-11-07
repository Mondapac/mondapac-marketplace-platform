import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IMPORT_JOB_STATES } from '../domain/import-jobs/import-job-core';
import { SELLER_IMPORT_MODES } from '../domain/seller-import/columns';
import { SELLER_STOP_REASONS } from '../domain/seller-import/seller-import-job';

// The requests and answers of the seller import (catalog design 14c).

export class SellerImportCheckRequest {
  @ApiProperty({ enum: SELLER_IMPORT_MODES, description: 'What the file does.' })
  mode!: string;

  @ApiProperty({
    description:
      'The file name as the browser sent it. It is only a label: it is cleaned to letters, digits and ' +
      '. _ ( ) - and spaces, never echoed as sent and never part of a path.',
  })
  fileName?: string;

  @ApiProperty({
    description:
      'The file as standard base64 text: a CSV file (UTF-8, comma-separated, a header row) or an XLSX ' +
      'workbook (first worksheet, no formulas, no macros), at most 10 MiB and 5,000 rows. A ZIP of ' +
      'photos is never opened here.',
  })
  data!: string;
}

export class SellerImportStartRequest {
  @ApiProperty({
    description:
      'true leaves out the rows with errors. A file with errors is confirmed only with true.',
  })
  skipErrors!: boolean;
}

export class SellerImportPhotoRequest {
  @ApiProperty({ description: 'The photo name as the file listed it (matched without case).' })
  name!: string;

  @ApiProperty({ description: 'The photo as standard base64 text (JPEG, PNG or WebP, 4 MiB).' })
  data!: string;
}

export class SellerImportColumnDto {
  @ApiProperty() key!: string;
  @ApiProperty() header!: string;
  @ApiProperty() required!: boolean;
}

export class SellerImportTemplateModeDto {
  @ApiProperty({ enum: SELLER_IMPORT_MODES }) mode!: string;
  @ApiProperty({ type: [SellerImportColumnDto] }) columns!: SellerImportColumnDto[];
  @ApiProperty() filename!: string;
  @ApiProperty({ description: 'The template file as CSV text.' }) csv!: string;
  @ApiProperty() xlsxFilename!: string;
  @ApiProperty({ description: 'The same template as an XLSX file, standard base64.' })
  xlsx!: string;
}

export class SellerImportTemplateDto {
  @ApiProperty({ type: [SellerImportTemplateModeDto] }) modes!: SellerImportTemplateModeDto[];
  @ApiProperty({ type: [String] }) typesOffered!: string[];
  @ApiProperty({ type: Object }) limits!: { rows: number; fileBytes: number };
}

export class SellerImportErrorLineDto {
  @ApiProperty() rowNumber!: number;
  @ApiProperty() column!: string;
  @ApiProperty() code!: string;
  @ApiProperty() value!: string;
  @ApiProperty({ nullable: true, type: Number }) otherRow!: number | null;
}

export class SellerImportFailureLineDto {
  @ApiProperty() rowNumber!: number;
  @ApiProperty() sku!: string;
  @ApiProperty() code!: string;
}

export class SellerImportPreviewRowDto {
  @ApiProperty() rowNumber!: number;
  @ApiProperty() sku!: string;
  @ApiProperty() title!: string;
  @ApiProperty() productCode!: string;
  @ApiProperty() typeCode!: string;
  @ApiProperty() options!: string;
}

export class SellerIgnoredColumnDto {
  @ApiProperty() header!: string;
  @ApiProperty({
    enum: ['certification', 'elsewhere'],
    nullable: true,
    type: String,
    description:
      '`certification`: never imported; `elsewhere`: price, cost and stock are set in Prices and Stock.',
  })
  mark!: string | null;
}

export class SellerImportDto {
  @ApiProperty({ format: 'uuid' }) id!: string;
  @ApiProperty({ enum: SELLER_IMPORT_MODES }) mode!: string;
  @ApiProperty({ enum: IMPORT_JOB_STATES }) state!: string;
  @ApiProperty() fileLabel!: string;
  @ApiProperty() fileBytes!: number;
  @ApiProperty({ enum: ['csv', 'xlsx'] }) format!: string;
  @ApiProperty() rows!: number;
  @ApiProperty() ready!: number;
  @ApiProperty() errors!: number;
  @ApiProperty() warnings!: number;
  @ApiProperty({
    description: 'Products (my-products) or Offers (sell-from-catalogue) in the file.',
  })
  groups!: number;
  @ApiProperty({ type: [SellerIgnoredColumnDto] }) ignoredColumns!: SellerIgnoredColumnDto[];
  @ApiProperty({ nullable: true, type: Boolean }) skipErrors!: boolean | null;
  @ApiProperty({ nullable: true, type: Number }) toImport!: number | null;
  @ApiProperty() created!: number;
  @ApiProperty() updated!: number;
  @ApiProperty() unchanged!: number;
  @ApiProperty() failed!: number;
  @ApiProperty({ enum: SELLER_STOP_REASONS, nullable: true, type: String })
  stopReason!: string | null;
  @ApiProperty() canResume!: boolean;
  @ApiProperty({
    description: 'The photo step is open (a my-products import ended within 7 days).',
  })
  photoStepOpen!: boolean;
  @ApiProperty() checkedAt!: string;
  @ApiProperty({ nullable: true, type: String }) startedAt!: string | null;
  @ApiProperty({ nullable: true, type: String }) finishedAt!: string | null;
  @ApiProperty({ nullable: true, type: Number }) durationSeconds!: number | null;
  @ApiProperty({
    type: [SellerImportErrorLineDto],
    description: 'At most 100; the report has all.',
  })
  errorLines!: SellerImportErrorLineDto[];
  @ApiProperty({ type: [SellerImportFailureLineDto], description: 'At most 100.' })
  failureLines!: SellerImportFailureLineDto[];
  @ApiProperty({ type: [SellerImportPreviewRowDto], description: 'The first five ready rows.' })
  preview!: SellerImportPreviewRowDto[];
}

export class SellerImportCurrentDto {
  @ApiPropertyOptional({ type: SellerImportDto, nullable: true })
  import!: SellerImportDto | null;
}

export class SellerImportDiscardedDto {
  @ApiProperty() discarded!: boolean;
}

export class SellerImportPhotoDto {
  @ApiProperty({ format: 'uuid' }) productId!: string;
  @ApiProperty({ type: Object }) image!: {
    imageId: string;
    width: number;
    height: number;
    createdAt: string;
  };
}
