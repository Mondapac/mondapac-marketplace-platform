import type { SeededType } from '../../application/ports/type-seed';
import type { CertificationTypeCode } from '../../domain/claim-types';

const code = (value: string): CertificationTypeCode => value as CertificationTypeCode;

/**
 * The synthetic Market's types (design 5.2): one with document and expiry, one active
 * `SELF_DECLARATION` with auto-approval. Its locales are ja-JP and en-US; the made-up words
 * carry no meaning in any real language.
 */
export const ZZ_CERTIFICATION_TYPES: readonly SeededType[] = [
  {
    code: code('qorvane'),
    status: 'active',
    content: {
      verificationMode: 'THIRD_PARTY_DOCUMENT',
      requiresIssuerRegistry: true,
      requiresDocument: true,
      requiresExpiry: true,
      defaultBasis: 'SELLER_REQUIRED',
      autoApproveSelfDeclaration: false,
      badgeIconKey: 'seal',
      locales: {
        'ja-JP': {
          name: 'コルヴェイン',
          customerDescription: '出品者はコルヴェインの証明書を保有しています。',
          claimTerms: ['コルヴェイン', 'qorvane'],
        },
        'en-US': {
          name: 'Qorvane',
          customerDescription: 'The seller holds a Qorvane certificate.',
          claimTerms: ['qorvane', 'qorvaine'],
        },
      },
    },
  },
  {
    code: code('zedpure'),
    status: 'active',
    content: {
      verificationMode: 'SELF_DECLARATION',
      requiresIssuerRegistry: false,
      requiresDocument: false,
      requiresExpiry: false,
      defaultBasis: 'NOT_APPLICABLE',
      autoApproveSelfDeclaration: true,
      badgeIconKey: 'leaf',
      locales: {
        'ja-JP': {
          name: 'ゼッドピュア',
          customerDescription: '出品者はゼッドピュアを自己申告しています。',
          claimTerms: ['ゼッドピュア'],
        },
        'en-US': {
          name: 'Zedpure',
          customerDescription: 'The seller declares this product is Zedpure.',
          claimTerms: ['zedpure', 'zed pure'],
        },
      },
    },
  },
];
