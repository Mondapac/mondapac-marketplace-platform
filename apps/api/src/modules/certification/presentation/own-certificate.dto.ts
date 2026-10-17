import { ApiProperty } from '@nestjs/swagger';

// Answers and requests of the seller certificate routes (certification design 7.2). Ids, codes
// and the seller's own content only; instants are ISO 8601 strings in UTC, dates are local dates.

export class CertificationErrorBody {
  @ApiProperty() statusCode!: number;
  @ApiProperty({ description: 'A stable machine-readable code, such as certificate.not-found.' })
  code!: string;
  @ApiProperty({ required: false, type: Object })
  details?: Record<string, unknown>;
}

export class CertificateCreateRequest {
  @ApiProperty({ description: 'The code of an active certification type of the Market.' })
  typeCode!: string;
}

export class CertificateSummaryView {
  @ApiProperty({ format: 'uuid' }) certificateId!: string;
  @ApiProperty() typeCode!: string;
  @ApiProperty({ description: 'The seller-visible status code (design 3.3).' }) status!: string;
  @ApiProperty({ description: 'The status of the record itself.' }) recordStatus!: string;
  @ApiProperty({ nullable: true, type: String }) submitBy!: string | null;
  @ApiProperty() editable!: boolean;
  @ApiProperty() deletable!: boolean;
  @ApiProperty() withdrawable!: boolean;
  @ApiProperty() createdAt!: string;
  @ApiProperty() lastChangedAt!: string;
}

export class CertificateListView {
  @ApiProperty({ type: [CertificateSummaryView] }) certificates!: CertificateSummaryView[];
  @ApiProperty({ nullable: true, type: String }) nextAfterId!: string | null;
}

export class CertificateDraftView {
  @ApiProperty({ nullable: true, type: String, format: 'uuid' }) issuerId!: string | null;
  @ApiProperty({ nullable: true, type: String }) certificateNumber!: string | null;
  @ApiProperty({ nullable: true, type: String, example: '2027-06-30' }) issueDate!: string | null;
  @ApiProperty({ nullable: true, type: String, example: '2028-06-30' }) expiryDate!: string | null;
  @ApiProperty({ nullable: true, type: Boolean }) selfDeclared!: boolean | null;
  @ApiProperty({ nullable: true, type: String }) selfDeclarationNote!: string | null;
}

export class CertificateDocumentView {
  @ApiProperty({ format: 'uuid' }) documentId!: string;
  @ApiProperty() position!: number;
  @ApiProperty({ enum: ['image/jpeg', 'image/png', 'application/pdf'] }) mediaType!: string;
  @ApiProperty() byteSize!: number;
  @ApiProperty({ nullable: true, type: Number }) pageCount!: number | null;
  @ApiProperty() createdAt!: string;
}

export class CertificateDetailView {
  @ApiProperty({ type: CertificateSummaryView }) certificate!: CertificateSummaryView;
  @ApiProperty({ type: CertificateDraftView }) draft!: CertificateDraftView;
  @ApiProperty({ type: [CertificateDocumentView] }) documents!: CertificateDocumentView[];
}

export class CertificateDraftSaved {
  @ApiProperty({ type: CertificateSummaryView }) certificate!: CertificateSummaryView;
  @ApiProperty({ type: CertificateDraftView }) draft!: CertificateDraftView;
}

export class CertificateDraftRequest {
  @ApiProperty({ nullable: true, type: String, format: 'uuid' }) issuerId!: string | null;
  @ApiProperty({ nullable: true, type: String, description: 'At most 64 characters.' })
  certificateNumber!: string | null;
  @ApiProperty({ nullable: true, type: String, example: '2027-06-30' }) issueDate!: string | null;
  @ApiProperty({ nullable: true, type: String, example: '2028-06-30' }) expiryDate!: string | null;
  @ApiProperty({ nullable: true, type: Boolean }) selfDeclared!: boolean | null;
  @ApiProperty({ nullable: true, type: String, description: 'At most 1000 characters.' })
  selfDeclarationNote!: string | null;
}

export class CertificateSubmitted {
  @ApiProperty({ format: 'uuid' }) certificateId!: string;
  @ApiProperty({ format: 'uuid' }) submissionId!: string;
  @ApiProperty({ enum: ['initial', 'resubmission', 'renewal'] }) kind!: string;
  @ApiProperty() submittedAt!: string;
}

export class CertificateDocumentUploadRequest {
  @ApiProperty({
    description:
      'The file as standard base64 text: JPEG, PNG or PDF, at most 10 MiB of bytes. The type is ' +
      'read from the content.',
  })
  data!: string;
}

export class CertificateIssuerOption {
  @ApiProperty({ format: 'uuid' }) issuerId!: string;
  @ApiProperty() displayName!: string;
}

export class CertificateTypeOption {
  @ApiProperty() code!: string;
  @ApiProperty({ type: Object, additionalProperties: { type: 'string' } })
  names!: Record<string, string>;
  @ApiProperty({ enum: ['THIRD_PARTY_DOCUMENT', 'SELF_DECLARATION'] }) verificationMode!: string;
  @ApiProperty() requiresIssuerRegistry!: boolean;
  @ApiProperty() requiresDocument!: boolean;
  @ApiProperty() requiresExpiry!: boolean;
  @ApiProperty({ type: [CertificateIssuerOption] }) issuers!: CertificateIssuerOption[];
}

export class CertificateOptionsView {
  @ApiProperty({ type: [CertificateTypeOption] }) types!: CertificateTypeOption[];
}

export class CertificateDeleted {
  @ApiProperty() deleted!: true;
}

export class CertificateDocumentRemoved {
  @ApiProperty() removed!: true;
}
