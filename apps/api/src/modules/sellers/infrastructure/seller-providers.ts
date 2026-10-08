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
import {
  LOCATION_TIMEZONE_RESOLVER,
  type LocationTimezoneResolver,
} from '../application/ports/location-timezone-resolver';
import {
  BUSINESS_IDENTIFIER_SCHEMES,
  type BusinessIdentifierSchemes,
} from '../application/ports/business-identifier-scheme';
import {
  BUSINESS_REGISTER_LOOKUPS,
  type BusinessRegisterLookup,
  type BusinessRegisterLookups,
} from '../application/ports/business-register-lookup';
import { IDENTIFIER_INDEX, type IdentifierIndex } from '../application/ports/identifier-index';
import { RATE_COUNTER_KEYS, type RateCounterKeys } from '../application/ports/rate-counter-keys';
import {
  RATE_COUNTER_REPOSITORY,
  type RateCounterRepository,
} from '../application/ports/rate-counter.repository';
import {
  REGISTER_CHECK_REPOSITORY,
  type RegisterCheckRepository,
} from '../application/ports/register-check.repository';
import {
  REGISTER_LOOKUP_POLICY,
  type RegisterLookupPolicy,
} from '../application/ports/register-lookup-policy';
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
import {
  TAX_PROFILE_REPOSITORY,
  type TaxProfileRepository,
} from '../application/ports/tax-profile.repository';
import { HmacIdentifierIndex } from './hmac-identifier-index';
import { HmacRateCounterKeys, localSellersSecret } from './hmac-rate-counter-keys';
import { MarketConfigIdentifierSchemes } from './identifier-schemes';
import { NoneLocationTimezoneResolver } from './location-timezone-resolvers';
import { MarketConfigRegisterLookupPolicy } from './market-config-register-lookup-policy';
import { PrismaRegisterCheckRepository } from './prisma-register-check.repository';
import { FAKE_REGISTER_ADAPTER, FakeRegisterLookup } from './register-lookups/fake';
import { MarketConfigRegisterLookups, availableRegisterAdapterCodes } from './register-lookups';
import { IdentityRegisteredSellers } from './identity-registered-sellers';
import { DirectoryServiceAreas, MarketConfigSellerFormats } from './market-config-seller-formats';
import { MarketConfigSellerPolicy } from './market-config-seller-policy';
import { PrismaRateCounterRepository } from './prisma-rate-counter.repository';
import { PrismaSellerFileRepository } from './prisma-seller-file.repository';
import { PrismaShopSlugRepository } from './prisma-shop-slug.repository';
import { PrismaTaxProfileRepository } from './prisma-tax-profile.repository';
import { SubjectKeySellerFileCipher } from './subject-key-seller-file-cipher';

/** One adapter serves both Market-format ports; a token of its own lets them share it. */
const SELLER_FORMATS = Symbol('SELLER_FORMATS');

/** The sellers stack secret (data design 4.4): one secret, an HKDF label per keyed hash. */
const SELLERS_SECRET = Symbol('SELLERS_SECRET');

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
    provide: SELLERS_SECRET,
    inject: [APP_CONFIG],
    useFactory: (config: AppConfig): Uint8Array => localSellersSecret(config),
  },
  {
    provide: RATE_COUNTER_KEYS,
    inject: [SELLERS_SECRET],
    useFactory: (secret: Uint8Array): RateCounterKeys => new HmacRateCounterKeys(secret),
  },
  {
    provide: IDENTIFIER_INDEX,
    inject: [SELLERS_SECRET],
    useFactory: (secret: Uint8Array): IdentifierIndex => new HmacIdentifierIndex(secret),
  },
  {
    // The start-up check of design 4.2: a hosted Market naming a scheme with no adapter throws here.
    provide: BUSINESS_IDENTIFIER_SCHEMES,
    inject: [MarketRegistry],
    useFactory: (markets: MarketRegistry): BusinessIdentifierSchemes =>
      new MarketConfigIdentifierSchemes(markets),
  },
  {
    provide: TAX_PROFILE_REPOSITORY,
    inject: [PrismaService],
    useFactory: (prisma: PrismaService): TaxProfileRepository =>
      new PrismaTaxProfileRepository(prisma),
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
    // The `none` adapter until Market configuration can name another
    // (`sellers.locationTimezone.adapter`, spike 3 record; a shared-file change).
    provide: LOCATION_TIMEZONE_RESOLVER,
    useFactory: (): LocationTimezoneResolver => new NoneLocationTimezoneResolver(),
  },
  {
    provide: REGISTER_CHECK_REPOSITORY,
    inject: [PrismaService],
    useFactory: (prisma: PrismaService): RegisterCheckRepository =>
      new PrismaRegisterCheckRepository(prisma),
  },
  {
    // The start-up check of design 4.2 (Hassan L3): a hosted Market naming a register adapter this
    // environment does not have throws here, so the Region Stack does not start.
    provide: REGISTER_LOOKUP_POLICY,
    inject: [MarketRegistry, APP_CONFIG],
    useFactory: (markets: MarketRegistry, config: AppConfig): RegisterLookupPolicy =>
      new MarketConfigRegisterLookupPolicy(markets, availableRegisterAdapterCodes(config)),
  },
  {
    // The adapters of this environment: the `fake` only where a development or test start is
    // explicit (it answers from a table and refuses production); the register's own adapter
    // joins in slice 4b.
    provide: BUSINESS_REGISTER_LOOKUPS,
    inject: [REGISTER_LOOKUP_POLICY, APP_CONFIG],
    useFactory: (policy: RegisterLookupPolicy, config: AppConfig): BusinessRegisterLookups => {
      const adapters = new Map<string, BusinessRegisterLookup>();
      if (availableRegisterAdapterCodes(config).has(FAKE_REGISTER_ADAPTER)) {
        adapters.set(FAKE_REGISTER_ADAPTER, new FakeRegisterLookup());
      }
      return new MarketConfigRegisterLookups(policy, adapters);
    },
  },
  {
    provide: REGISTERED_SELLER_SOURCE,
    inject: [SELLER_ACCESS_CONTRACT],
    useFactory: (identity: SellerAccessContract): RegisteredSellerSource =>
      new IdentityRegisteredSellers(identity),
  },
];
