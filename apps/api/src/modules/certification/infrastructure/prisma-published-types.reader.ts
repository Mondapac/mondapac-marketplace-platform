import type { Id, MarketContext } from '@mondapac/shared-kernel';
import type { PrismaService } from '../../../platform/persistence/prisma.service';
import type { PublishedTypesReader } from '../application/ports/published-types.reader';
import type { CertificationTypeView } from '../contracts/certification.facade';
import type { ClaimVocabularyEntry } from '../domain/claim-text-matcher';
import type { CertificationTypeCode } from '../domain/claim-types';
import type { TypeDefaultBasis, VerificationMode } from '../domain/type-revision';

const STATUSES = ['active', 'inactive'] as const;
const MODES: readonly string[] = ['THIRD_PARTY_DOCUMENT', 'SELF_DECLARATION'];
const BASES: readonly string[] = ['SELLER_REQUIRED', 'NOT_APPLICABLE'];

/**
 * {@link PublishedTypesReader} on `certification.certification_types`, its published revision,
 * texts and claim terms (data design 3.1 to 3.3). It reads inside the caller's unit and asks for
 * every type row of the Market, active or inactive: a type whose published revision is missing
 * or unreadable, or that has no claim term, rejects the whole read (the caller answers
 * `unavailable`), never drops the type, because a dropped type would let its words pass unseen
 * (Hassan, #142). Output order is fixed in code (type code, then locale, then phrase), never the
 * database's. The revisions are insert-only, so a pointer read and its revision read cannot
 * disagree about a revision's content even on READ COMMITTED.
 */
export class PrismaPublishedTypesReader implements PublishedTypesReader {
  constructor(private readonly prisma: PrismaService) {}

  async claimVocabulary(market: MarketContext): Promise<readonly ClaimVocabularyEntry[]> {
    const rows = await this.readTypes(market, undefined);
    return rows.map((row) => {
      const terms = row.revision.texts.flatMap((text) => text.terms.map((term) => term.phrase));
      if (terms.length === 0) {
        throw new Error(
          `certification type ${row.code} has no claim term on its published revision`,
        );
      }
      return { typeCode: row.code as CertificationTypeCode, terms: sortedUnique(terms) };
    });
  }

  async types(
    market: MarketContext,
    filter: { readonly status?: 'active' | 'inactive' },
  ): Promise<readonly CertificationTypeView[]> {
    const rows = await this.readTypes(market, filter.status);
    return rows.map((row) => {
      const { revision } = row;
      if (
        !isOneOf(revision.verificationMode, MODES) ||
        revision.verificationMode !== row.verificationMode
      ) {
        throw new Error(`certification type ${row.code} has an invalid verification mode`);
      }
      if (!isOneOf(revision.defaultBasis, BASES)) {
        throw new Error(`certification type ${row.code} has an invalid default basis`);
      }
      const locales: Record<string, { name: string; customerDescription: string }> = {};
      for (const text of revision.texts) {
        locales[text.locale] = { name: text.name, customerDescription: text.customerDescription };
      }
      return {
        code: row.code as CertificationTypeCode,
        status: row.status,
        publishedRevisionId: revision.id as Id,
        verificationMode: revision.verificationMode as VerificationMode,
        requiresIssuerRegistry: revision.requiresIssuerRegistry,
        requiresDocument: revision.requiresDocument,
        requiresExpiry: revision.requiresExpiry,
        defaultBasis: revision.defaultBasis as TypeDefaultBasis,
        autoApproveSelfDeclaration: revision.autoApproveSelfDeclaration,
        badgeIconKey: revision.badgeIconKey,
        locales,
      };
    });
  }

  /** Every type row of the Market in code order, each with its resolved published revision. */
  private async readTypes(market: MarketContext, status: 'active' | 'inactive' | undefined) {
    const rows = await this.prisma.tx(market).certificationType.findMany({
      where: { marketId: market.marketId, ...(status === undefined ? {} : { status }) },
      include: {
        publishedRevision: {
          include: { texts: { include: { terms: true } } },
        },
      },
    });
    const sorted = [...rows].sort((a, b) => compareCode(a.code, b.code));
    return sorted.map((row) => {
      if (!isOneOf(row.status, STATUSES)) {
        throw new Error(`certification type ${row.code} has an invalid status`);
      }
      const revision = row.publishedRevision;
      if (
        row.publishedRevisionId === null ||
        revision === null ||
        revision.id !== row.publishedRevisionId
      ) {
        throw new Error(`certification type ${row.code} has no readable published revision`);
      }
      return {
        code: row.code,
        status: row.status,
        verificationMode: row.verificationMode,
        revision: {
          ...revision,
          texts: [...revision.texts]
            .sort((a, b) => compareCode(a.locale, b.locale))
            .map((text) => ({
              ...text,
              terms: [...text.terms].sort((a, b) => compareCode(a.phrase, b.phrase)),
            })),
        },
      };
    });
  }
}

/** Code-unit order, independent of the database collation. */
function compareCode(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

function sortedUnique(values: readonly string[]): string[] {
  return [...new Set(values)].sort(compareCode);
}

function isOneOf<T extends string>(value: string, allowed: readonly T[]): value is T {
  return (allowed as readonly string[]).includes(value);
}
