import type { FactoryProvider } from '@nestjs/common';
import { MarketRegistry } from '../../../platform/market-config/market-registry';
import { SubjectRateLimits } from '../../../platform/rate-limit/subject-rate-limits';
import { ADMIN_DAY_ZONE, type AdminDayZone } from '../application/ports/admin-day-zone';
import { ActorOrMarketDayZone } from './actor-or-market-day-zone';
import { PrismaService } from '../../../platform/persistence/prisma.service';
import {
  SUBJECT_KEY_SERVICE,
  type SubjectKeyService,
} from '../../../platform/subject-keys/subject-key-service';
import {
  ACCOUNT_DELETION_SETTINGS_REPOSITORY,
  type AccountDeletionSettingsRepository,
} from '../application/ports/account-deletion-settings.repository';
import { ADDRESS_CIPHER, type AddressCipher } from '../application/ports/address-cipher';
import { ADDRESS_POLICY, type AddressPolicy } from '../application/ports/address-policy';
import {
  ADMIN_ACTION_LIMITS,
  type AdminActionLimits,
} from '../application/ports/admin-action-limits';
import {
  ADDRESS_REPOSITORY,
  type AddressRepository,
} from '../application/ports/address.repository';
import {
  ACCOUNT_DELETION_REQUEST_REPOSITORY,
  type AccountDeletionRequestRepository,
} from '../application/ports/account-deletion-request.repository';
import { ACCOUNT_DELETION_PEERS } from '../application/ports/account-deletion-peers';
import {
  CUSTOMER_READ_MODEL_REPOSITORY,
  type CustomerReadModelRepository,
} from '../application/ports/customer-read-models.repository';
import { CUSTOMER_READ_MODEL_PEERS } from '../application/ports/customer-read-model-peers';
import {
  CUSTOMER_LIST_READER,
  type CustomerListReader,
} from '../application/ports/customer-list.reader';
import {
  SAVED_FILTER_REPOSITORY,
  type SavedFilterRepository,
} from '../application/ports/saved-filter.repository';
import { SHEET_WRITER, type SheetWriter } from '../application/ports/sheet-writer';
import {
  CUSTOMER_GROUP_REPOSITORY,
  type CustomerGroupRepository,
} from '../application/ports/customer-groups.repository';
import { CUSTOMER_MANAGEMENT_PEERS } from '../application/ports/customer-management-peers';
import {
  CUSTOMER_NOTE_CIPHER,
  CUSTOMER_NOTE_REPOSITORY,
  type CustomerNoteCipher,
  type CustomerNoteRepository,
} from '../application/ports/customer-notes.repository';
import {
  CUSTOMER_TIMELINE_REPOSITORY,
  type CustomerTimelineRepository,
} from '../application/ports/customer-timeline.repository';
import { LateBoundManagementPeers } from './late-bound-management-peers';
import { PrismaCustomerGroupRepository } from './prisma-customer-groups.repository';
import { PrismaCustomerNoteRepository } from './prisma-customer-notes.repository';
import { PrismaCustomerTimelineRepository } from './prisma-customer-timeline.repository';
import { SubjectKeyNoteCipher } from './subject-key-note-cipher';
import {
  CUSTOMER_CODES,
  SELLER_CUSTOMER_REPOSITORY,
  TREND_ZONES,
  type CustomerCodes,
  type SellerCustomerRepository,
  type TrendZones,
} from '../application/ports/seller-customers.repository';
import { PrismaSellerCustomerRepository } from './prisma-seller-customers.repository';
import { RandomCustomerCodes } from './random-customer-codes';
import { RegistryTrendZones } from './registry-trend-zones';
import { PrismaCustomerListReader } from './prisma-customer-list.reader';
import { PrismaSavedFilterRepository } from './prisma-saved-filter.repository';
import { ExceljsSheetWriter } from './xlsx/exceljs-sheet-writer';
import { LateBoundReadModelPeers } from './late-bound-read-model-peers';
import { PrismaCustomerReadModelRepository } from './prisma-customer-read-models.repository';
import { LateBoundAccountDeletionPeers } from './late-bound-account-deletion-peers';
import { PrismaAccountDeletionRequestRepository } from './prisma-account-deletion-request.repository';
import { PrismaAccountDeletionSettingsRepository } from './prisma-account-deletion-settings.repository';
import { ConfigAddressPolicy } from './config-address-policy';
import { SubjectAdminActionLimits } from './subject-admin-action-limits';
import { PrismaAddressRepository } from './prisma-address.repository';
import { SubjectKeyAddressCipher } from './subject-key-address-cipher';

/** Binds the ports of customers. Only this layer may reach `PrismaService` and subject keys. */
export const customersProviders: readonly FactoryProvider[] = [
  {
    provide: ADDRESS_REPOSITORY,
    inject: [PrismaService],
    useFactory: (prisma: PrismaService): AddressRepository => new PrismaAddressRepository(prisma),
  },
  {
    provide: ADDRESS_CIPHER,
    inject: [SUBJECT_KEY_SERVICE],
    useFactory: (keys: SubjectKeyService): AddressCipher => new SubjectKeyAddressCipher(keys),
  },
  {
    provide: ADDRESS_POLICY,
    inject: [MarketRegistry],
    useFactory: (markets: MarketRegistry): AddressPolicy => new ConfigAddressPolicy(markets),
  },
  {
    provide: ADMIN_ACTION_LIMITS,
    inject: [SubjectRateLimits, MarketRegistry],
    useFactory: (counters: SubjectRateLimits, markets: MarketRegistry): AdminActionLimits =>
      new SubjectAdminActionLimits(counters, markets),
  },
  {
    provide: ACCOUNT_DELETION_REQUEST_REPOSITORY,
    inject: [PrismaService],
    useFactory: (prisma: PrismaService): AccountDeletionRequestRepository =>
      new PrismaAccountDeletionRequestRepository(prisma),
  },
  {
    provide: ACCOUNT_DELETION_PEERS,
    useFactory: (): LateBoundAccountDeletionPeers => new LateBoundAccountDeletionPeers(),
  },
  {
    provide: ACCOUNT_DELETION_SETTINGS_REPOSITORY,
    inject: [PrismaService],
    useFactory: (prisma: PrismaService): AccountDeletionSettingsRepository =>
      new PrismaAccountDeletionSettingsRepository(prisma),
  },
  {
    provide: CUSTOMER_READ_MODEL_REPOSITORY,
    inject: [PrismaService],
    useFactory: (prisma: PrismaService): CustomerReadModelRepository =>
      new PrismaCustomerReadModelRepository(prisma),
  },
  {
    provide: CUSTOMER_READ_MODEL_PEERS,
    useFactory: (): LateBoundReadModelPeers => new LateBoundReadModelPeers(),
  },
  {
    provide: CUSTOMER_LIST_READER,
    inject: [PrismaService],
    useFactory: (prisma: PrismaService): CustomerListReader => new PrismaCustomerListReader(prisma),
  },
  {
    provide: SAVED_FILTER_REPOSITORY,
    inject: [PrismaService],
    useFactory: (prisma: PrismaService): SavedFilterRepository =>
      new PrismaSavedFilterRepository(prisma),
  },
  {
    provide: SHEET_WRITER,
    useFactory: (): SheetWriter => new ExceljsSheetWriter(),
  },
  {
    provide: CUSTOMER_GROUP_REPOSITORY,
    inject: [PrismaService],
    useFactory: (prisma: PrismaService): CustomerGroupRepository =>
      new PrismaCustomerGroupRepository(prisma),
  },
  {
    provide: CUSTOMER_NOTE_REPOSITORY,
    inject: [PrismaService],
    useFactory: (prisma: PrismaService): CustomerNoteRepository =>
      new PrismaCustomerNoteRepository(prisma),
  },
  {
    provide: CUSTOMER_NOTE_CIPHER,
    inject: [SUBJECT_KEY_SERVICE],
    useFactory: (keys: SubjectKeyService): CustomerNoteCipher => new SubjectKeyNoteCipher(keys),
  },
  {
    provide: CUSTOMER_TIMELINE_REPOSITORY,
    inject: [PrismaService],
    useFactory: (prisma: PrismaService): CustomerTimelineRepository =>
      new PrismaCustomerTimelineRepository(prisma),
  },
  {
    provide: CUSTOMER_MANAGEMENT_PEERS,
    useFactory: (): LateBoundManagementPeers => new LateBoundManagementPeers(),
  },
  {
    provide: ADMIN_DAY_ZONE,
    inject: [MarketRegistry, CUSTOMER_MANAGEMENT_PEERS],
    useFactory: (markets: MarketRegistry, peers: LateBoundManagementPeers): AdminDayZone =>
      new ActorOrMarketDayZone(markets, peers.identity),
  },
  {
    provide: SELLER_CUSTOMER_REPOSITORY,
    inject: [PrismaService],
    useFactory: (prisma: PrismaService): SellerCustomerRepository =>
      new PrismaSellerCustomerRepository(prisma),
  },
  {
    provide: CUSTOMER_CODES,
    useFactory: (): CustomerCodes => new RandomCustomerCodes(),
  },
  {
    provide: TREND_ZONES,
    inject: [MarketRegistry],
    useFactory: (markets: MarketRegistry): TrendZones => new RegistryTrendZones(markets),
  },
];
