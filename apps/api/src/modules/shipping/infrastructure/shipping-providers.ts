import type { FactoryProvider } from '@nestjs/common';
import type { Clock } from '@mondapac/shared-kernel';
import { CLOCK } from '../../../platform/clock/clock.module';
import { APP_CONFIG } from '../../../platform/config/config.module';
import type { AppConfig } from '../../../platform/config/app-config';
import { MarketRegistry } from '../../../platform/market-config/market-registry';
import { ServiceAreaDirectory } from '../../../platform/market-config/service-area-directory';
import { PrismaService } from '../../../platform/persistence/prisma.service';
import { SELLERS_FACADE, type SellersFacade } from '../../sellers';
import {
  CARRIER_BOOKING_REPOSITORY,
  type CarrierBookingRepository,
} from '../application/ports/carrier-booking.repository';
import { CARRIER_GATEWAY, type CarrierGateway } from '../application/ports/carrier-gateway';
import { CARRIER_POLICY } from '../application/ports/carrier-policy';
import {
  CARRIER_WEBHOOK_SIGNATURE,
  type CarrierWebhookSignature,
} from '../application/ports/carrier-webhook-signature';
import {
  FLAT_FEE_REPOSITORY,
  type FlatFeeRepository,
} from '../application/ports/flat-fee.repository';
import { PICKUP_DIRECTORY, type PickupDirectory } from '../application/ports/pickup-directory';
import { SELLER_DIRECTORY, type SellerDirectory } from '../application/ports/seller-directory';
import { STORE_DIRECTORY, type StoreDirectory } from '../application/ports/store-directory';
import { SHIPPING_POLICY, type ShippingPolicy } from '../application/ports/shipping-policy';
import { CircuitBreaker } from './circuit-breaker';
import { ConfigCarrierPolicy } from './config-carrier-policy';
import { ConfigShippingPolicy } from './config-shipping-policy';
import { DriveHttpClient } from './drive-http-client';
import { DriveWebhookSignature } from './drive-webhook-signature';
import { MondapacDriveCarrier } from './mondapac-drive-carrier';
import { PrismaCarrierBookingRepository } from './prisma-carrier-booking.repository';
import { PrismaFlatFeeRepository } from './prisma-flat-fee.repository';
import { SellersPickupDirectory } from './sellers-pickup-directory';
import { SellersSellerDirectory } from './sellers-seller-directory';
import { SellersStoreDirectory } from './sellers-store-directory';

/** Binds the ports of shipping. Only this layer may reach `PrismaService`. */
export const shippingProviders: readonly FactoryProvider[] = [
  {
    provide: FLAT_FEE_REPOSITORY,
    inject: [PrismaService],
    useFactory: (prisma: PrismaService): FlatFeeRepository => new PrismaFlatFeeRepository(prisma),
  },
  {
    provide: SHIPPING_POLICY,
    inject: [MarketRegistry, ServiceAreaDirectory],
    useFactory: (markets: MarketRegistry, areas: ServiceAreaDirectory): ShippingPolicy =>
      new ConfigShippingPolicy(markets, areas),
  },
  {
    provide: SELLER_DIRECTORY,
    inject: [SELLERS_FACADE],
    useFactory: (sellers: SellersFacade): SellerDirectory => new SellersSellerDirectory(sellers),
  },
  {
    provide: STORE_DIRECTORY,
    inject: [SELLERS_FACADE],
    useFactory: (sellers: SellersFacade): StoreDirectory => new SellersStoreDirectory(sellers),
  },
  {
    provide: CARRIER_BOOKING_REPOSITORY,
    inject: [PrismaService],
    useFactory: (prisma: PrismaService): CarrierBookingRepository =>
      new PrismaCarrierBookingRepository(prisma),
  },
  {
    provide: CARRIER_POLICY,
    inject: [MarketRegistry, ServiceAreaDirectory, APP_CONFIG],
    useFactory: (
      markets: MarketRegistry,
      areas: ServiceAreaDirectory,
      config: AppConfig,
    ): ConfigCarrierPolicy => new ConfigCarrierPolicy(markets, areas, config.mondapacDrive),
  },
  {
    provide: CARRIER_GATEWAY,
    inject: [CARRIER_POLICY, APP_CONFIG, CLOCK],
    useFactory: (policy: ConfigCarrierPolicy, config: AppConfig, clock: Clock): CarrierGateway =>
      new MondapacDriveCarrier(
        policy,
        config.mondapacDrive.apiKeys,
        new DriveHttpClient(new CircuitBreaker(clock)),
      ),
  },
  {
    provide: CARRIER_WEBHOOK_SIGNATURE,
    inject: [APP_CONFIG, CLOCK],
    useFactory: (config: AppConfig, clock: Clock): CarrierWebhookSignature =>
      new DriveWebhookSignature(config.mondapacDrive.webhookSecrets, clock),
  },
  {
    provide: PICKUP_DIRECTORY,
    inject: [SELLERS_FACADE, MarketRegistry],
    useFactory: (sellers: SellersFacade, markets: MarketRegistry): PickupDirectory =>
      new SellersPickupDirectory(sellers, markets),
  },
];
