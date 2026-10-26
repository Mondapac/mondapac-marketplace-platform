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
    provide: ACCOUNT_DELETION_SETTINGS_REPOSITORY,
    inject: [PrismaService],
    useFactory: (prisma: PrismaService): AccountDeletionSettingsRepository =>
      new PrismaAccountDeletionSettingsRepository(prisma),
  },
];
