import type { FactoryProvider } from '@nestjs/common';
import { MarketRegistry } from '../../../platform/market-config/market-registry';
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
import { PrismaCustomerListReader } from './prisma-customer-list.reader';
import { PrismaSavedFilterRepository } from './prisma-saved-filter.repository';
import { ExceljsSheetWriter } from './xlsx/exceljs-sheet-writer';
import { LateBoundReadModelPeers } from './late-bound-read-model-peers';
import { PrismaCustomerReadModelRepository } from './prisma-customer-read-models.repository';
import { LateBoundAccountDeletionPeers } from './late-bound-account-deletion-peers';
import { PrismaAccountDeletionRequestRepository } from './prisma-account-deletion-request.repository';
import { PrismaAccountDeletionSettingsRepository } from './prisma-account-deletion-settings.repository';
import { ConfigAddressPolicy } from './config-address-policy';
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
];
