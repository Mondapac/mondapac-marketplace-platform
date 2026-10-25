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
import type { CarrierGateway } from '../application/ports/carrier-gateway';
import { CARRIER_POLICY } from '../application/ports/carrier-policy';
import {
  CARRIER_WEBHOOK_SIGNATURE,
  type CarrierWebhookSignature,
} from '../application/ports/carrier-webhook-signature';
import { FLEET_REGISTRY, type FleetRegistry } from '../application/ports/fleet-registry';
import {
  FLEET_SELECTION_REPOSITORY,
  type FleetSelectionRepository,
} from '../application/ports/fleet-selection.repository';
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
import { ConfigUberDirectPolicy } from './config-uber-direct-policy';
import { ConfigZoom2uPolicy } from './config-zoom2u-policy';
import { DriveHttpClient } from './drive-http-client';
import { FakeTestCarrier } from './fake-test-carrier';
import { capabilitiesOf } from './fleet-config';
import { StaticFleetRegistry } from './fleet-registry';
import { DriveWebhookSignature } from './drive-webhook-signature';
import { MondapacDriveCarrier } from './mondapac-drive-carrier';
import { PrismaCarrierBookingRepository } from './prisma-carrier-booking.repository';
import { PrismaFleetSelectionRepository } from './prisma-fleet-selection.repository';
import { PrismaFlatFeeRepository } from './prisma-flat-fee.repository';
import { SellersPickupDirectory } from './sellers-pickup-directory';
import { SellersSellerDirectory } from './sellers-seller-directory';
import { SellersStoreDirectory } from './sellers-store-directory';
import { UberDirectCarrier } from './uber-direct-carrier';
import { UberDirectHttpClient } from './uber-direct-http-client';
import { Zoom2uCarrier } from './zoom2u-carrier';
import { Zoom2uHttpClient } from './zoom2u-http-client';

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
    provide: FLEET_SELECTION_REPOSITORY,
    inject: [PrismaService],
    useFactory: (prisma: PrismaService): FleetSelectionRepository =>
      new PrismaFleetSelectionRepository(prisma),
  },
  {
    // One gateway per fleet. Mondapac Drive, Uber Direct and Zoom2u are registered here;
    // Australia Post registers its own beside them. The fake is for tests and development: it is
    // never registered in production and is on only where a Market's `shipping.fleets` lists it.
    provide: FLEET_REGISTRY,
    inject: [CARRIER_POLICY, MarketRegistry, APP_CONFIG, CLOCK],
    useFactory: (
      policy: ConfigCarrierPolicy,
      markets: MarketRegistry,
      config: AppConfig,
      clock: Clock,
    ): FleetRegistry => {
      const gateways: CarrierGateway[] = [
        new MondapacDriveCarrier(
          policy,
          config.mondapacDrive.apiKeys,
          new DriveHttpClient(new CircuitBreaker(clock)),
          clock,
        ),
        // Off (no capabilities, so never a candidate) unless the Market's
        // `shipping.uberDirect.enabled` is true AND the Region Stack holds its credentials.
        new UberDirectCarrier(
          new ConfigUberDirectPolicy(markets, config.uberDirect),
          new UberDirectHttpClient(new CircuitBreaker(clock), clock),
          clock,
        ),
        // Off unless the Market's `shipping.zoom2u.enabled` is true AND the Region Stack holds
        // its API key.
        new Zoom2uCarrier(
          new ConfigZoom2uPolicy(markets, config.zoom2u),
          new Zoom2uHttpClient(new CircuitBreaker(clock)),
          clock,
        ),
      ];
      if (config.nodeEnv !== 'production') {
        gateways.push(
          new FakeTestCarrier((market) => {
            const entry = policy.fleetEntry(market.marketId, 'fake_test');
            return entry === undefined
              ? null
              : capabilitiesOf('fake_test', entry, markets.get(market.marketId).defaultCurrency, {
                  idempotentBooking: true,
                  supportsWindow: true,
                });
          }),
        );
      }
      return new StaticFleetRegistry(gateways);
    },
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
