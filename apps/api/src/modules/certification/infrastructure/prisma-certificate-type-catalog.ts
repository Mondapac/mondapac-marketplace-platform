import type { Id, MarketContext } from '@mondapac/shared-kernel';
import type { PrismaService } from '../../../platform/persistence/prisma.service';
import type {
  CertificateTypeCatalog,
  IssuerChoice,
  SellerTypeView,
} from '../application/ports/certificate-type-catalog';
import type { TypeSettings } from '../domain/seller-certificate';
import type { IssuerState } from '../domain/validity';

const MODES: readonly string[] = ['THIRD_PARTY_DOCUMENT', 'SELF_DECLARATION'];

const TYPE_INCLUDE = { publishedRevision: { include: { texts: true } } } as const;

interface TypeRow {
  id: string;
  code: string;
  status: string;
  publishedRevisionId: string | null;
  publishedRevision: {
    id: string;
    verificationMode: string;
    requiresIssuerRegistry: boolean;
    requiresDocument: boolean;
    requiresExpiry: boolean;
    texts: readonly { locale: string; name: string }[];
  } | null;
}

/** A type with no readable published revision is a fault: reject, never drop (fail closed). */
function toView(row: TypeRow): SellerTypeView {
  const revision = row.publishedRevision;
  if (
    revision === null ||
    revision.id !== row.publishedRevisionId ||
    !MODES.includes(revision.verificationMode) ||
    (row.status !== 'active' && row.status !== 'inactive')
  ) {
    throw new Error(`certification type ${row.code} has no readable published revision`);
  }
  const names: Record<string, string> = {};
  for (const text of revision.texts) names[text.locale] = text.name;
  return {
    typeId: row.id as Id<'CertificationType'>,
    code: row.code,
    status: row.status,
    revisionId: revision.id as Id<'CertificationTypeRevision'>,
    verificationMode: revision.verificationMode as TypeSettings['verificationMode'],
    requiresIssuerRegistry: revision.requiresIssuerRegistry,
    requiresDocument: revision.requiresDocument,
    requiresExpiry: revision.requiresExpiry,
    names,
  };
}

function toIssuer(row: {
  id: string;
  typeId: string;
  displayName: string;
  state: string;
}): IssuerChoice {
  return {
    id: row.id as Id<'Issuer'>,
    typeId: row.typeId as Id<'CertificationType'>,
    displayName: row.displayName,
    state: row.state as IssuerState,
  };
}

/**
 * {@link CertificateTypeCatalog} on the type registry tables of `certification` (data design 3.1
 * to 3.3, 3.7). Reads inside the caller's unit.
 */
export class PrismaCertificateTypeCatalog implements CertificateTypeCatalog {
  constructor(private readonly prisma: PrismaService) {}

  async typeByCode(market: MarketContext, code: string): Promise<TypeSettings | null> {
    const row = await this.prisma.tx(market).certificationType.findFirst({
      where: { marketId: market.marketId, code },
      include: TYPE_INCLUDE,
    });
    return row === null ? null : toView(row);
  }

  async typeById(
    market: MarketContext,
    typeId: Id<'CertificationType'>,
  ): Promise<TypeSettings | null> {
    const row = await this.prisma.tx(market).certificationType.findFirst({
      where: { marketId: market.marketId, id: typeId },
      include: TYPE_INCLUDE,
    });
    return row === null ? null : toView(row);
  }

  async issuer(market: MarketContext, issuerId: Id<'Issuer'>): Promise<IssuerChoice | null> {
    const row = await this.prisma.tx(market).certificationIssuer.findFirst({
      where: { marketId: market.marketId, id: issuerId },
      select: { id: true, typeId: true, displayName: true, state: true },
    });
    return row === null ? null : toIssuer(row);
  }

  async activeIssuers(
    market: MarketContext,
    typeId: Id<'CertificationType'>,
  ): Promise<readonly IssuerChoice[]> {
    const rows = await this.prisma.tx(market).certificationIssuer.findMany({
      where: { marketId: market.marketId, typeId, state: 'active' },
      select: { id: true, typeId: true, displayName: true, state: true },
      orderBy: [{ displayNameKey: 'asc' }, { id: 'asc' }],
      take: 500,
    });
    return rows.map(toIssuer);
  }

  async activeTypes(market: MarketContext): Promise<readonly SellerTypeView[]> {
    const rows = await this.prisma.tx(market).certificationType.findMany({
      where: { marketId: market.marketId, status: 'active' },
      include: TYPE_INCLUDE,
      orderBy: { code: 'asc' },
    });
    return rows.map(toView);
  }
}
