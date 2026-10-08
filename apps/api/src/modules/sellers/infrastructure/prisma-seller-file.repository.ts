import { Temporal } from '@mondapac/shared-kernel';
import type { Id, MarketContext, MarketId, PlainText } from '@mondapac/shared-kernel';
import type { PrismaService } from '../../../platform/persistence/prisma.service';
import type { SellerFileRepository } from '../application/ports/seller-file.repository';
import type { Sealed, SealedField } from '../domain/sealed';
import {
  NEW_SELLER_ADMIN_SETTINGS,
  SELLER_FILE_ORIGINS,
  SellerFile,
  type SellerFileOrigin,
} from '../domain/seller-file';
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
      // Slice 2: no revision exists yet. Slice 5 adds `approved_revision_id` and reads
      // `approvedRevisionId !== null` here; until then no file is frozen.
      hasApprovedRevision: false,
      draft: {
        storeName,
        businessName: sealed<'business-name'>(row.businessNameCiphertext),
        phone: sealed<'phone'>(row.phoneCiphertext),
        contactEmail: sealed<'contact-email'>(row.contactEmailCiphertext),
        address: sealed<'address'>(row.addressCiphertext),
        registeredAddress: sealed<'registered-address'>(row.registeredAddressCiphertext),
        serviceAreaCode: row.serviceAreaCode,
        zone: zoneOf(row),
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
        draftComplete: state.draftComplete,
        lastChangedAt: toDate(state.lastChangedAt),
        version: state.version,
      },
    });
    return count === 1;
  }
}
