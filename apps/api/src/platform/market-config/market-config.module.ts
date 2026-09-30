import { Global, Module } from '@nestjs/common';
import type { AppConfig } from '../config/app-config';
import { APP_CONFIG } from '../config/config.module';
import { loadMarketConfigs } from './market-config';
import { MarketRegistry } from './market-registry';

/** Loads and validates Market configuration at startup; invalid configuration stops the boot. */
@Global()
@Module({
  providers: [
    {
      provide: MarketRegistry,
      inject: [APP_CONFIG],
      useFactory: (config: AppConfig) =>
        new MarketRegistry(loadMarketConfigs(config.marketConfigDirs, config.hostedMarkets)),
    },
  ],
  exports: [MarketRegistry],
})
export class MarketConfigModule {}
