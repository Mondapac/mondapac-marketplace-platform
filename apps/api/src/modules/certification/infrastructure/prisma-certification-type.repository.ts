import type { MarketContext } from '@mondapac/shared-kernel';
import type { PrismaService } from '../../../platform/persistence/prisma.service';
import type {
  CertificationTypeRepository,
  NewSeededType,
} from '../application/ports/certification-type.repository';

/**
 * {@link CertificationTypeRepository} on `certification.certification_types` and its revision,
 * texts and claim terms (data design 3.1 to 3.3). Inserts only, inside the caller's unit: the
 * type is inserted without a pointer, then its revision, texts and terms, then the pointer moves
 * (the unit that creates a type is the only one that sees a NULL pointer).
 */
export class PrismaCertificationTypeRepository implements CertificationTypeRepository {
  constructor(private readonly prisma: PrismaService) {}

  async existsByCode(market: MarketContext, code: string): Promise<boolean> {
    const row = await this.prisma.tx(market).certificationType.findFirst({
      where: { marketId: market.marketId, code },
      select: { id: true },
    });
    return row !== null;
  }

  async addSeeded(market: MarketContext, input: NewSeededType): Promise<void> {
    const tx = this.prisma.tx(market);
    const { seeded } = input;
    const { content } = seeded;
    const createdAt = new Date(input.createdAt.epochMilliseconds);
    const scope = { marketId: market.marketId, tenantId: market.tenantId };
    await tx.certificationType.create({
      data: {
        id: input.typeId,
        ...scope,
        code: seeded.code,
        verificationMode: content.verificationMode,
        status: seeded.status,
        publishedRevisionId: null,
        version: 1,
        createdAt,
      },
      select: { id: true },
    });
    await tx.certificationTypeRevision.create({
      data: {
        id: input.revisionId,
        ...scope,
        typeId: input.typeId,
        revisionNo: 1,
        verificationMode: content.verificationMode,
        requiresIssuerRegistry: content.requiresIssuerRegistry,
        requiresDocument: content.requiresDocument,
        requiresExpiry: content.requiresExpiry,
        defaultBasis: content.defaultBasis,
        autoApproveSelfDeclaration: content.autoApproveSelfDeclaration,
        badgeIconKey: content.badgeIconKey,
        authorAccountId: input.authorAccountId,
        createdAt,
      },
      select: { id: true },
    });
    for (const [locale, text] of Object.entries(content.locales)) {
      await tx.certificationTypeRevisionText.create({
        data: {
          ...scope,
          typeRevisionId: input.revisionId,
          locale,
          name: text.name,
          customerDescription: text.customerDescription,
        },
        select: { locale: true },
      });
      if (text.claimTerms.length > 0) {
        await tx.certificationClaimTerm.createMany({
          data: [...new Set(text.claimTerms)].map((phrase) => ({
            ...scope,
            typeRevisionId: input.revisionId,
            locale,
            phrase,
          })),
        });
      }
    }
    await tx.certificationType.update({
      where: { id: input.typeId, marketId: market.marketId },
      data: { publishedRevisionId: input.revisionId },
      select: { id: true },
    });
  }
}
