import type { FactoryProvider } from '@nestjs/common';
import type { AppConfig } from '../../../platform/config/app-config';
import { APP_CONFIG } from '../../../platform/config/config.module';
import { MarketRegistry } from '../../../platform/market-config/market-registry';
import { ServiceAreaDirectory } from '../../../platform/market-config/service-area-directory';
import { PrismaService } from '../../../platform/persistence/prisma.service';
import {
  SUBJECT_KEY_SERVICE,
  type SubjectKeyService,
} from '../../../platform/subject-keys/subject-key-service';
import {
  SELLER_ACCESS_CONTRACT,
  type SellerAccessContract,
} from '../../identity/contracts/seller-access.contract';
import { RATE_COUNTER_KEYS, type RateCounterKeys } from '../application/ports/rate-counter-keys';
import {
  RATE_COUNTER_REPOSITORY,
  type RateCounterRepository,
} from '../application/ports/rate-counter.repository';
import {
  REGISTERED_SELLER_SOURCE,
  type RegisteredSellerSource,
} from '../application/ports/registered-seller-source';
import { SELLER_FILE_CIPHER, type SellerFileCipher } from '../application/ports/seller-file-cipher';
import {
  SELLER_FILE_REPOSITORY,
  type SellerFileRepository,
} from '../application/ports/seller-file.repository';
import {
  ADDRESS_FORMATS,
  SERVICE_AREAS,
  TIMEZONE_RESOLVER,
  type AddressFormats,
  type ServiceAreas,
  type TimezoneResolver,
} from '../application/ports/seller-market-formats';
import {
  SELLER_MARKET_POLICY,
  type SellerMarketPolicy,
} from '../application/ports/seller-market-policy';
import {
  SHOP_SLUG_REPOSITORY,
  type ShopSlugRepository,
} from '../application/ports/shop-slug.repository';
import { HmacRateCounterKeys, localSellersSecret } from './hmac-rate-counter-keys';
import { IdentityRegisteredSellers } from './identity-registered-sellers';
import { DirectoryServiceAreas, MarketConfigSellerFormats } from './market-config-seller-formats';
import { MarketConfigSellerPolicy } from './market-config-seller-policy';
import { PrismaRateCounterRepository } from './prisma-rate-counter.repository';
import { PrismaSellerFileRepository } from './prisma-seller-file.repository';
import { PrismaShopSlugRepository } from './prisma-shop-slug.repository';
import { SubjectKeySellerFileCipher } from './subject-key-seller-file-cipher';

/** One adapter serves both Market-format ports; a token of its own lets them share it. */
const SELLER_FORMATS = Symbol('SELLER_FORMATS');

/**
 * Binds the ports of sellers. They live in `infrastructure/` because only this layer may reach
 * `PrismaService`, the subject-key service and identity's seller-access contract
 * (dependency-cruiser `persistence-internals-are-private`, `subject-keys-only-in-infrastructure`,
 * `seller-access-contract-is-for-sellers`).
 */
export const sellerProviders: readonly FactoryProvider[] = [
  {
    provide: SELLER_FILE_REPOSITORY,
    inject: [PrismaService],
    useFactory: (prisma: PrismaService): SellerFileRepository =>
      new PrismaSellerFileRepository(prisma),
  },
  {
    provide: SHOP_SLUG_REPOSITORY,
    inject: [PrismaService],
    useFactory: (prisma: PrismaService): ShopSlugRepository => new PrismaShopSlugRepository(prisma),
  },
  {
    provide: RATE_COUNTER_REPOSITORY,
    inject: [PrismaService],
    useFactory: (prisma: PrismaService): RateCounterRepository =>
      new PrismaRateCounterRepository(prisma),
  },
  {
    // The local stand-in of the sellers stack secret refuses production (data design 4.4; K1).
    provide: RATE_COUNTER_KEYS,
    inject: [APP_CONFIG],
    useFactory: (config: AppConfig): RateCounterKeys =>
      new HmacRateCounterKeys(localSellersSecret(config)),
  },
  {
    provide: SELLER_FILE_CIPHER,
    inject: [SUBJECT_KEY_SERVICE],
    useFactory: (keys: SubjectKeyService): SellerFileCipher => new SubjectKeySellerFileCipher(keys),
  },
  {
    provide: SELLER_MARKET_POLICY,
    inject: [MarketRegistry],
    useFactory: (markets: MarketRegistry): SellerMarketPolicy =>
      new MarketConfigSellerPolicy(markets),
  },
  {
    provide: SELLER_FORMATS,
    inject: [MarketRegistry],
    useFactory: (markets: MarketRegistry) => new MarketConfigSellerFormats(markets),
  },
  {
    provide: ADDRESS_FORMATS,
    inject: [SELLER_FORMATS],
    useFactory: (formats: MarketConfigSellerFormats): AddressFormats => formats,
  },
  {
    provide: TIMEZONE_RESOLVER,
    inject: [SELLER_FORMATS],
    useFactory: (formats: MarketConfigSellerFormats): TimezoneResolver => formats,
  },
  {
    provide: SERVICE_AREAS,
    inject: [ServiceAreaDirectory],
    useFactory: (directory: ServiceAreaDirectory): ServiceAreas =>
      new DirectoryServiceAreas(directory),
  },
  {
    provide: REGISTERED_SELLER_SOURCE,
    inject: [SELLER_ACCESS_CONTRACT],
    useFactory: (identity: SellerAccessContract): RegisteredSellerSource =>
      new IdentityRegisteredSellers(identity),
  },
];
