import { Temporal } from '@mondapac/shared-kernel';
import type { Id, MarketContext, MarketId, PlainText } from '@mondapac/shared-kernel';
import type { PrismaService } from '../../../platform/persistence/prisma.service';
import type { SellerFileRepository } from '../application/ports/seller-file.repository';
import { identifierIndexKeyOf, type DraftIdentifier } from '../domain/business-identifier';
import {
  DECISION_INTENT_KINDS,
  type DecisionIntent,
  type DecisionIntentKind,
} from '../domain/decision-intent';
import type { Sealed, SealedField } from '../domain/sealed';
import {
  NEW_SELLER_ADMIN_SETTINGS,
  SELLER_FILE_ORIGINS,
  SellerFile,
  type SellerFileOrigin,
} from '../domain/seller-file';
import type { ShopSlug } from '../domain/shop-slug';
import type { StoreName } from '../domain/store-name';
import { TIMEZONE_SOURCES, type TimezoneSource, type ZoneState } from '../domain/zone';

const toDate = (instant: Temporal.Instant): Date => new Date(instant.epochMilliseconds);
const toInstant = (date: Date): Temporal.Instant =>
  Temporal.Instant.fromEpochMilliseconds(date.getTime());

/** The largest id list one read takes (sellers design 7.1: `sellerSummaries` is bounded by its caller). */
const MAX_IDS = 100;

/** The columns of a file this repository reads: everything the aggregate holds. */
const FILE_COLUMNS = {
  sellerId: true,
  marketId: true,
  origin: true,
  approvalRequiredAtRegistration: true,
  draftComplete: true,
  lastChangedAt: true,
  version: true,
  createdAt: true,
  storeName: true,
  storeNameKey: true,
  businessNameCiphertext: true,
  phoneCiphertext: true,
  contactEmailCiphertext: true,
  addressCiphertext: true,
  registeredAddressCiphertext: true,
  serviceAreaCode: true,
  operatingTimezone: true,
  timezoneSource: true,
  addressTimezone: true,
  draftSlug: true,
  identifierScheme: true,
  identifierCiphertext: true,
  identifierIndex: true,
  approvedRevisionId: true,
  decisionIntent: true,
  decisionAttemptId: true,
  decisionRevisionId: true,
  decisionIntentSince: true,
} as const;

/** A stored row that breaks the domain's rules: a fault of the data, never a value to use. */
export class StoredSellerFileError extends Error {
  override readonly name = 'StoredSellerFileError';
  constructor(column: string) {
    super(`sellers.seller_files holds an invalid ${column}`);
  }
}

const sealed = <F extends SealedField>(value: string | null): Sealed<F> | null =>
  value as Sealed<F> | null;

function zoneOf(row: {
  readonly operatingTimezone: string | null;
  readonly timezoneSource: string | null;
  readonly addressTimezone: string | null;
}): ZoneState | null {
  const { operatingTimezone, timezoneSource, addressTimezone } = row;
  // The CHECK `seller_files_timezone_set_check` keeps the three together.
  if (operatingTimezone === null || timezoneSource === null || addressTimezone === null) {
    return null;
  }
  if (!(TIMEZONE_SOURCES as readonly string[]).includes(timezoneSource)) {
    throw new StoredSellerFileError('timezone_source');
  }
  return {
    operatingTimezone,
    timezoneSource: timezoneSource as TimezoneSource,
    addressTimezone,
  };
}

function identifierOf(row: {
  readonly identifierScheme: string | null;
  readonly identifierCiphertext: string | null;
  readonly identifierIndex: Uint8Array | null;
}): DraftIdentifier | null {
  const { identifierScheme, identifierCiphertext, identifierIndex } = row;
  // The CHECK `seller_files_identifier_set_check` keeps the three together.
  if (identifierScheme === null || identifierCiphertext === null || identifierIndex === null) {
    return null;
  }
  return {
    scheme: identifierScheme,
    sealed: sealed<'identifier'>(identifierCiphertext)!,
    index: identifierIndexKeyOf(new Uint8Array(identifierIndex)),
  };
}

function intentOf(row: {
  readonly decisionIntent: string | null;
  readonly decisionAttemptId: string | null;
  readonly decisionRevisionId: string | null;
  readonly decisionIntentSince: Date | null;
}): DecisionIntent | null {
  const { decisionIntent, decisionAttemptId, decisionRevisionId, decisionIntentSince } = row;
  // The CHECK `seller_files_decision_intent_set_check` keeps the four together.
  if (
    decisionIntent === null ||
    decisionAttemptId === null ||
    decisionRevisionId === null ||
    decisionIntentSince === null
  ) {
    return null;
  }
  if (!(DECISION_INTENT_KINDS as readonly string[]).includes(decisionIntent)) {
    throw new StoredSellerFileError('decision_intent');
  }
  return {
    kind: decisionIntent as DecisionIntentKind,
    attemptId: decisionAttemptId as Id<'DecisionAttempt'>,
    revisionId: decisionRevisionId as Id<'BusinessFileRevision'>,
    since: toInstant(decisionIntentSince),
  };
}

/**
 * {@link SellerFileRepository} on `sellers.seller_files` and the three roots that share its id
 * (data design 3.1, 3.7, 3.8, 3.9). Every statement goes through `PrismaService.tx(market)` with
 * `marketId` at the top level of `where`; writes are single statements, never nested. The file
 * is inserted first with `skipDuplicates`: a count of zero means a file of this id exists, and
 * nothing else is written, so a repeated or concurrent creation converges on the primary key.
 * A draft save is one `updateMany` guarded by the version the file was read with.
 */
export class PrismaSellerFileRepository implements SellerFileRepository {
  constructor(private readonly prisma: PrismaService) {}

  async addWithRoots(market: MarketContext, file: SellerFile): Promise<boolean> {
    const state = file.state;
    const tx = this.prisma.tx(market);
    const { count } = await tx.sellersSellerFile.createMany({
      data: [
        {
          sellerId: state.sellerId,
          marketId: market.marketId,
          tenantId: market.tenantId,
          origin: state.origin,
          approvalRequiredAtRegistration: state.approvalRequiredAtRegistration,
          draftComplete: state.draftComplete,
          lastChangedAt: toDate(state.lastChangedAt),
          version: state.version,
          createdAt: toDate(state.createdAt),
        },
      ],
      skipDuplicates: true,
    });
    if (count === 0) return false;

    const common = {
      sellerId: state.sellerId,
      marketId: market.marketId,
      tenantId: market.tenantId,
      version: 1,
      createdAt: toDate(state.createdAt),
    };
    await tx.sellersSellerAdminSettings.create({
      data: { ...common, ...NEW_SELLER_ADMIN_SETTINGS },
      select: { sellerId: true },
    });
    await tx.sellersSellerTaxProfile.create({ data: common, select: { sellerId: true } });
    await tx.sellersStoreProfile.create({ data: common, select: { sellerId: true } });
    return true;
  }

  async existingIds(
    market: MarketContext,
    sellerIds: readonly Id<'Seller'>[],
  ): Promise<ReadonlySet<Id<'Seller'>>> {
    if (sellerIds.length === 0) return new Set();
    if (sellerIds.length > MAX_IDS) throw new RangeError('existingIds: at most 100 ids');
    const rows = await this.prisma.tx(market).sellersSellerFile.findMany({
      where: { marketId: market.marketId, sellerId: { in: [...sellerIds] } },
      select: { sellerId: true },
    });
    return new Set(rows.map((row) => row.sellerId as Id<'Seller'>));
  }

  async draftZones(
    market: MarketContext,
    sellerIds: readonly Id<'Seller'>[],
  ): Promise<ReadonlyMap<Id<'Seller'>, string>> {
    if (sellerIds.length === 0) return new Map();
    if (sellerIds.length > MAX_IDS) throw new RangeError('draftZones: at most 100 ids');
    const rows = await this.prisma.tx(market).sellersSellerFile.findMany({
      where: {
        marketId: market.marketId,
        sellerId: { in: [...sellerIds] },
        operatingTimezone: { not: null },
      },
      select: { sellerId: true, operatingTimezone: true },
    });
    const zones = new Map<Id<'Seller'>, string>();
    for (const row of rows) {
      if (row.operatingTimezone !== null)
        zones.set(row.sellerId as Id<'Seller'>, row.operatingTimezone);
    }
    return zones;
  }

  async findById(market: MarketContext, sellerId: Id<'Seller'>): Promise<SellerFile | null> {
    const row = await this.prisma.tx(market).sellersSellerFile.findFirst({
      where: { marketId: market.marketId, sellerId },
      select: FILE_COLUMNS,
    });
    if (row === null) return null;
    if (!(SELLER_FILE_ORIGINS as readonly string[]).includes(row.origin)) {
      throw new StoredSellerFileError('origin');
    }
    // Read back as stored: the CHECKs hold the pair, and a later change of the name rules must
    // not make a stored draft unreadable (the next save applies them).
    if ((row.storeName === null) !== (row.storeNameKey === null)) {
      throw new StoredSellerFileError('store_name_key');
    }
    const storeName: StoreName | null =
      row.storeName === null || row.storeNameKey === null
        ? null
        : { name: row.storeName as PlainText, key: row.storeNameKey };
    return SellerFile.restore({
      sellerId: row.sellerId as Id<'Seller'>,
      marketId: row.marketId as MarketId,
      origin: row.origin as SellerFileOrigin,
      approvalRequiredAtRegistration: row.approvalRequiredAtRegistration,
      draftComplete: row.draftComplete,
      lastChangedAt: toInstant(row.lastChangedAt),
      version: row.version,
      createdAt: toInstant(row.createdAt),
      // Slice 5: the file is frozen (draft saves refused) as soon as the V1 pointer names a
      // revision (data design 3.1); slice 7a-decide moves the pointer.
      hasApprovedRevision: row.approvedRevisionId !== null,
      decisionIntent: intentOf(row),
      draft: {
        storeName,
        businessName: sealed<'business-name'>(row.businessNameCiphertext),
        phone: sealed<'phone'>(row.phoneCiphertext),
        contactEmail: sealed<'contact-email'>(row.contactEmailCiphertext),
        address: sealed<'address'>(row.addressCiphertext),
        registeredAddress: sealed<'registered-address'>(row.registeredAddressCiphertext),
        serviceAreaCode: row.serviceAreaCode,
        zone: zoneOf(row),
        // Read back as stored (the CHECK holds the format); the reserved words are not re-checked.
        slug: row.draftSlug as ShopSlug | null,
        identifier: identifierOf(row),
      },
    });
  }

  async saveDraft(market: MarketContext, file: SellerFile): Promise<boolean> {
    const { state } = file;
    const { draft } = state;
    if (state.version !== file.persistedVersion + 1) {
      throw new RangeError('saveDraft: one save raises the version by exactly one');
    }
    const { count } = await this.prisma.tx(market).sellersSellerFile.updateMany({
      where: {
        marketId: market.marketId,
        sellerId: state.sellerId,
        version: file.persistedVersion,
      },
      data: {
        storeName: draft.storeName?.name ?? null,
        storeNameKey: draft.storeName?.key ?? null,
        businessNameCiphertext: draft.businessName,
        phoneCiphertext: draft.phone,
        contactEmailCiphertext: draft.contactEmail,
        addressCiphertext: draft.address,
        registeredAddressCiphertext: draft.registeredAddress,
        serviceAreaCode: draft.serviceAreaCode,
        operatingTimezone: draft.zone?.operatingTimezone ?? null,
        timezoneSource: draft.zone?.timezoneSource ?? null,
        addressTimezone: draft.zone?.addressTimezone ?? null,
        draftSlug: draft.slug,
        identifierScheme: draft.identifier?.scheme ?? null,
        identifierCiphertext: draft.identifier?.sealed ?? null,
        identifierIndex: draft.identifier === null ? null : Buffer.from(draft.identifier.index),
        draftComplete: state.draftComplete,
        lastChangedAt: toDate(state.lastChangedAt),
        version: state.version,
      },
    });
    return count === 1;
  }

  async recordChange(market: MarketContext, file: SellerFile): Promise<boolean> {
    const { state } = file;
    if (state.version !== file.persistedVersion + 1) {
      throw new RangeError('recordChange: one change raises the version by exactly one');
    }
    const { count } = await this.prisma.tx(market).sellersSellerFile.updateMany({
      where: {
        marketId: market.marketId,
        sellerId: state.sellerId,
        version: file.persistedVersion,
      },
      data: { lastChangedAt: toDate(state.lastChangedAt), version: state.version },
    });
    return count === 1;
  }

  async hold(market: MarketContext, file: SellerFile): Promise<boolean> {
    const { count } = await this.prisma.tx(market).sellersSellerFile.updateMany({
      where: {
        marketId: market.marketId,
        sellerId: file.state.sellerId,
        version: file.persistedVersion,
      },
      data: { version: file.persistedVersion },
    });
    return count === 1;
  }

  async recordDecision(
    market: MarketContext,
    file: SellerFile,
    approval: {
      readonly revisionId: Id<'BusinessFileRevision'>;
      readonly publicStoreName: string;
    } | null,
  ): Promise<boolean> {
    const { state } = file;
    if (state.version !== file.persistedVersion + 1) {
      throw new RangeError('recordDecision: one change raises the version by exactly one');
    }
    if (approval !== null && !state.hasApprovedRevision) {
      throw new RangeError('recordDecision: an approval needs the file to record it first');
    }
    const intent = state.decisionIntent;
    const { count } = await this.prisma.tx(market).sellersSellerFile.updateMany({
      where: {
        marketId: market.marketId,
        sellerId: state.sellerId,
        version: file.persistedVersion,
      },
      data: {
        lastChangedAt: toDate(state.lastChangedAt),
        version: state.version,
        decisionIntent: intent?.kind ?? null,
        decisionAttemptId: intent?.attemptId ?? null,
        decisionRevisionId: intent?.revisionId ?? null,
        decisionIntentSince: intent === null ? null : toDate(intent.since),
        ...(approval === null
          ? {}
          : {
              approvedRevisionId: approval.revisionId,
              publicStoreName: approval.publicStoreName,
            }),
      },
    });
    return count === 1;
  }

  async staleDecisionIntents(
    market: MarketContext,
    before: Temporal.Instant,
    limit: number,
  ): Promise<readonly Id<'Seller'>[]> {
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > MAX_IDS) {
      throw new RangeError('staleDecisionIntents: 1 to 100 rows');
    }
    const rows = await this.prisma.tx(market).sellersSellerFile.findMany({
      where: {
        marketId: market.marketId,
        decisionIntent: { not: null },
        decisionIntentSince: { lt: toDate(before) },
      },
      orderBy: { decisionIntentSince: 'asc' },
      take: limit,
      select: { sellerId: true },
    });
    return rows.map((row) => row.sellerId as Id<'Seller'>);
  }
}
