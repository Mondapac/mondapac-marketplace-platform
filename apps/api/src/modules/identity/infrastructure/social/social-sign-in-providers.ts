import type { FactoryProvider } from '@nestjs/common';
import type { Clock } from '@mondapac/shared-kernel';
import { CLOCK } from '../../../../platform/clock/clock.module';
import { APP_CONFIG } from '../../../../platform/config/config.module';
import type { AppConfig } from '../../../../platform/config/app-config';
import { MarketRegistry } from '../../../../platform/market-config/market-registry';
import { PrismaService } from '../../../../platform/persistence/prisma.service';
import {
  EXTERNAL_IDENTITY_REPOSITORY,
  type ExternalIdentityRepository,
} from '../../application/ports/external-identity.repository';
import {
  SIGN_IN_PROVIDER_FLOW_SECRETS,
  SIGN_IN_PROVIDERS_PORT,
  type SignInProviderFlowSecrets,
  type SignInProviders,
} from '../../application/ports/sign-in-providers';
import { HmacFlowSecrets } from './hmac-flow-secrets';
import { OidcSignInProviders } from './oidc-sign-in-providers';
import { PrismaExternalIdentityRepository } from './prisma-external-identity.repository';

/** Binds the ports of social sign-in: the providers, the flow secrets and the identity rows. */
export const socialSignInProviders: readonly FactoryProvider[] = [
  {
    provide: SIGN_IN_PROVIDERS_PORT,
    inject: [MarketRegistry, APP_CONFIG, CLOCK],
    useFactory: (markets: MarketRegistry, config: AppConfig, clock: Clock): SignInProviders =>
      new OidcSignInProviders(markets, config, clock),
  },
  {
    provide: SIGN_IN_PROVIDER_FLOW_SECRETS,
    useFactory: (): SignInProviderFlowSecrets => new HmacFlowSecrets(),
  },
  {
    provide: EXTERNAL_IDENTITY_REPOSITORY,
    inject: [PrismaService],
    useFactory: (prisma: PrismaService): ExternalIdentityRepository =>
      new PrismaExternalIdentityRepository(prisma),
  },
];
