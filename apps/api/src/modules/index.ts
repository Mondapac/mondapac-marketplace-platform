// Bounded-context modules of the core (ADR-0008 decision 3), each imported through its
// public entry point only.
import { IdentityModule } from './identity';
import { LegalModule } from './legal';
import { CustomersModule } from './customers';
import { SellersModule } from './sellers';
import { CertificationModule } from './certification';
import { CatalogModule } from './catalog';
import { InventoryModule } from './inventory';
import { PricingModule } from './pricing';
import { CartModule } from './cart';
import { OrderingModule } from './ordering';
import { PaymentsModule } from './payments';
import { CommissionPayoutsModule } from './commission-payouts';
import { TaxModule } from './tax';
import { ShippingModule } from './shipping';
import { ReturnsModule } from './returns';
import { NotificationsModule } from './notifications';
import { SearchModule } from './search';
import { StorefrontModule } from './storefront';
import { EngagementModule } from './engagement';
import { AssistantModule } from './assistant';

export const CORE_MODULES = [
  IdentityModule,
  CustomersModule,
  LegalModule,
  SellersModule,
  CertificationModule,
  CatalogModule,
  InventoryModule,
  PricingModule,
  CartModule,
  OrderingModule,
  PaymentsModule,
  CommissionPayoutsModule,
  TaxModule,
  ShippingModule,
  ReturnsModule,
  NotificationsModule,
  SearchModule,
  StorefrontModule,
  EngagementModule,
  AssistantModule,
];
