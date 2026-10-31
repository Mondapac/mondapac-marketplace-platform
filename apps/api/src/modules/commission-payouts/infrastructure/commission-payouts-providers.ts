import type { FactoryProvider } from '@nestjs/common';
import { MarketRegistry } from '../../../platform/market-config/market-registry';
import { PrismaService } from '../../../platform/persistence/prisma.service';
import { SELLERS_FACADE, type SellersFacade } from '../../sellers';
import { COMMISSION_POLICY, type CommissionPolicy } from '../application/ports/commission-policy';
import { LEDGER_REPOSITORY, type LedgerRepository } from '../application/ports/ledger.repository';
import { SELLER_DIRECTORY, type SellerDirectory } from '../application/ports/seller-directory';
import {
  SELLER_RATE_REPOSITORY,
  type SellerRateRepository,
} from '../application/ports/seller-rate.repository';
import {
  ELIGIBILITY_ANCHOR_REPOSITORY,
  type EligibilityAnchorRepository,
} from '../application/ports/eligibility-anchor.repository';
import {
  PAYOUT_HOLD_REPOSITORY,
  type PayoutHoldRepository,
} from '../application/ports/payout-hold.repository';
import {
  PAYOUT_TERMS_POLICY,
  type PayoutTermsPolicy,
} from '../application/ports/payout-terms-policy';
import {
  PAYOUT_TERMS_REPOSITORY,
  type PayoutTermsRepository,
} from '../application/ports/payout-terms.repository';
import { PAYOUT_TERMS_RESOLVER, PayoutTermsResolver } from '../application/payout-terms-resolver';
import {
  DISPUTE_REPOSITORY,
  type DisputeRepository,
} from '../application/ports/dispute.repository';
import { SELLER_NAMES, type SellerNames } from '../application/ports/seller-names';
import {
  PAYOUT_CURSOR_REPOSITORY,
  type PayoutCursorRepository,
} from '../application/ports/payout-cursor.repository';
import {
  PAYOUT_POLICY,
  PAYOUT_PREREQUISITES,
  SELLER_PAYOUT_ACCESS,
  type PayoutPolicy,
  type PayoutPrerequisites,
  type SellerPayoutAccess,
} from '../application/ports/payout-gateways';
import { PAYOUT_REPOSITORY, type PayoutRepository } from '../application/ports/payout.repository';
import { ConfigPayoutPolicy } from './config-payout-policy';
import { PrismaPayoutCursorRepository } from './prisma-payout-cursor.repository';
import { PrismaPayoutRepository } from './prisma-payout.repository';
import { SellersSellerPayoutAccess } from './sellers-seller-payout-access';
import { isLiveStripeKey, UnwiredPayoutPrerequisites } from './unwired-payout-prerequisites';
import { APP_CONFIG } from '../../../platform/config/config.module';
import type { AppConfig } from '../../../platform/config/app-config';
import { PrismaDisputeRepository } from './prisma-dispute.repository';
import { SellersSellerNames } from './sellers-seller-names';
import { ConfigCommissionPolicy } from './config-commission-policy';
import { ConfigPayoutTermsPolicy } from './config-payout-terms-policy';
import { PrismaEligibilityAnchorRepository } from './prisma-eligibility-anchor.repository';
import { PrismaPayoutHoldRepository } from './prisma-payout-hold.repository';
import { PrismaPayoutTermsRepository } from './prisma-payout-terms.repository';
import { PrismaLedgerRepository } from './prisma-ledger.repository';
import { PrismaSellerRateRepository } from './prisma-seller-rate.repository';
import { SellersSellerDirectory } from './sellers-seller-directory';

/** Binds the ports of commission-payouts. Only this layer may reach `PrismaService`. */
export const commissionPayoutsProviders: readonly FactoryProvider[] = [
  {
    provide: SELLER_RATE_REPOSITORY,
    inject: [PrismaService],
    useFactory: (prisma: PrismaService): SellerRateRepository =>
      new PrismaSellerRateRepository(prisma),
  },
  {
    provide: LEDGER_REPOSITORY,
    inject: [PrismaService],
    useFactory: (prisma: PrismaService): LedgerRepository => new PrismaLedgerRepository(prisma),
  },
  {
    provide: COMMISSION_POLICY,
    inject: [MarketRegistry],
    useFactory: (markets: MarketRegistry): CommissionPolicy => new ConfigCommissionPolicy(markets),
  },
  {
    provide: PAYOUT_TERMS_REPOSITORY,
    inject: [PrismaService],
    useFactory: (prisma: PrismaService): PayoutTermsRepository =>
      new PrismaPayoutTermsRepository(prisma),
  },
  {
    provide: ELIGIBILITY_ANCHOR_REPOSITORY,
    inject: [PrismaService],
    useFactory: (prisma: PrismaService): EligibilityAnchorRepository =>
      new PrismaEligibilityAnchorRepository(prisma),
  },
  {
    provide: PAYOUT_HOLD_REPOSITORY,
    inject: [PrismaService],
    useFactory: (prisma: PrismaService): PayoutHoldRepository =>
      new PrismaPayoutHoldRepository(prisma),
  },
  {
    provide: PAYOUT_TERMS_POLICY,
    inject: [MarketRegistry],
    useFactory: (markets: MarketRegistry): PayoutTermsPolicy =>
      new ConfigPayoutTermsPolicy(markets),
  },
  {
    provide: PAYOUT_TERMS_RESOLVER,
    inject: [PAYOUT_TERMS_POLICY, PAYOUT_TERMS_REPOSITORY],
    useFactory: (policy: PayoutTermsPolicy, overrides: PayoutTermsRepository) =>
      new PayoutTermsResolver(policy, overrides),
  },
  {
    provide: DISPUTE_REPOSITORY,
    inject: [PrismaService],
    useFactory: (prisma: PrismaService): DisputeRepository => new PrismaDisputeRepository(prisma),
  },
  {
    provide: SELLER_NAMES,
    inject: [SELLERS_FACADE],
    useFactory: (sellers: SellersFacade): SellerNames => new SellersSellerNames(sellers),
  },
  {
    provide: SELLER_DIRECTORY,
    inject: [SELLERS_FACADE],
    useFactory: (sellers: SellersFacade): SellerDirectory => new SellersSellerDirectory(sellers),
  },
  {
    provide: PAYOUT_REPOSITORY,
    inject: [PrismaService],
    useFactory: (prisma: PrismaService): PayoutRepository => new PrismaPayoutRepository(prisma),
  },
  {
    provide: PAYOUT_CURSOR_REPOSITORY,
    inject: [PrismaService],
    useFactory: (prisma: PrismaService): PayoutCursorRepository =>
      new PrismaPayoutCursorRepository(prisma),
  },
  {
    provide: PAYOUT_POLICY,
    inject: [MarketRegistry],
    useFactory: (markets: MarketRegistry): PayoutPolicy => new ConfigPayoutPolicy(markets),
  },
  {
    provide: SELLER_PAYOUT_ACCESS,
    inject: [SELLERS_FACADE],
    useFactory: (sellers: SellersFacade): SellerPayoutAccess =>
      new SellersSellerPayoutAccess(sellers),
  },
  {
    provide: PAYOUT_PREREQUISITES,
    inject: [APP_CONFIG],
    useFactory: (config: AppConfig): PayoutPrerequisites =>
      new UnwiredPayoutPrerequisites(isLiveStripeKey(config.stripeSecretKey)),
  },
];
