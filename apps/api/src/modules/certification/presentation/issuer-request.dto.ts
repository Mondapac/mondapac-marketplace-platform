import { ApiProperty } from '@nestjs/swagger';
import { CertificateDocumentView } from './own-certificate.dto';

// Answers and requests of the "my issuer is not listed" routes (certification design 2.1, 7.2;
// slice 6). Instants are ISO 8601 strings in UTC.

export class IssuerRequestCreateRequest {
  @ApiProperty({
    description: 'The code of an active type whose form takes the issuer from the registry.',
  })
  typeCode!: string;
  @ApiProperty({
    description:
      'The issuer name as the seller knows it, 1 to 200 characters of plain text. Request text ' +
      'only: it is never copied into the registry or a certificate.',
  })
  issuerName!: string;
  @ApiProperty({
    description: 'One file (the certificate) as standard base64: JPEG, PNG or PDF, at most 10 MiB.',
  })
  data!: string;
}

export class OwnIssuerRequestView {
  @ApiProperty({ format: 'uuid' }) issuerRequestId!: string;
  @ApiProperty() typeCode!: string;
  @ApiProperty({ enum: ['open'] }) state!: string;
  @ApiProperty() createdAt!: string;
}

export class IssuerQueueRowView {
  @ApiProperty({ format: 'uuid' }) issuerRequestId!: string;
  @ApiProperty() version!: number;
  @ApiProperty() typeCode!: string;
  @ApiProperty({ format: 'uuid' }) sellerId!: string;
  @ApiProperty({
    nullable: true,
    type: String,
    description: 'Null: the seller is not yet approved.',
  })
  storeName!: string | null;
  @ApiProperty() documentCount!: number;
  @ApiProperty() createdAt!: string;
}

export class IssuerQueueView {
  @ApiProperty({ type: [IssuerQueueRowView] }) items!: IssuerQueueRowView[];
  @ApiProperty({ nullable: true, type: String }) nextAfterId!: string | null;
  @ApiProperty() total!: number;
}

class IssuerRequestAnswerView {
  @ApiProperty({ nullable: true, type: String, format: 'uuid' }) issuerId!: string | null;
  @ApiProperty({ nullable: true, type: String }) reasonCode!: string | null;
  @ApiProperty() answeredAt!: string;
}

class IssuerChoiceView {
  @ApiProperty({ format: 'uuid' }) issuerId!: string;
  @ApiProperty() displayName!: string;
}

class IssuerRequestReasonView {
  @ApiProperty() code!: string;
  @ApiProperty() label!: string;
}

export class IssuerRequestPageView {
  @ApiProperty({ format: 'uuid' }) issuerRequestId!: string;
  @ApiProperty() version!: number;
  @ApiProperty({ enum: ['open', 'issuer-added', 'not-accepted'] }) state!: string;
  @ApiProperty() typeCode!: string;
  @ApiProperty({ format: 'uuid' }) sellerId!: string;
  @ApiProperty({ nullable: true, type: String }) storeName!: string | null;
  @ApiProperty({
    nullable: true,
    type: String,
    description:
      "The seller's typed text, decrypted for this read (audited). Plain text; never a registry " +
      "value. Null when the seller's key is gone.",
  })
  typedIssuerName!: string | null;
  @ApiProperty({ type: [CertificateDocumentView] }) documents!: CertificateDocumentView[];
  @ApiProperty() createdAt!: string;
  @ApiProperty({ nullable: true, type: IssuerRequestAnswerView })
  answer!: IssuerRequestAnswerView | null;
  @ApiProperty({ type: [IssuerChoiceView] }) activeIssuers!: IssuerChoiceView[];
  @ApiProperty({ type: [IssuerRequestReasonView] }) reasons!: IssuerRequestReasonView[];
}

export class IssuerRequestAnswerRequest {
  @ApiProperty({ description: 'The version of the request as read.' }) version!: number;
  @ApiProperty({ enum: ['issuer-added', 'not-accepted'] }) outcome!: string;
  @ApiProperty({
    required: false,
    format: 'uuid',
    description:
      'For issuer-added: an active issuer of the request type, created in the registry first.',
  })
  issuerId?: string;
  @ApiProperty({ required: false, description: 'For not-accepted: a reason code of the Market.' })
  reasonCode?: string;
}

export class IssuerRequestAnsweredView {
  @ApiProperty({ format: 'uuid' }) issuerRequestId!: string;
  @ApiProperty() version!: number;
  @ApiProperty({ enum: ['issuer-added', 'not-accepted'] }) state!: string;
  @ApiProperty() answeredAt!: string;
}
