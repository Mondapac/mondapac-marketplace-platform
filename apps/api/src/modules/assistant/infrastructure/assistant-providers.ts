import type { FactoryProvider } from '@nestjs/common';
import { CART_ASSISTANT_FACADE, type CartAssistantFacade } from '../../cart';
import { CATALOG_ASSISTANT_FACADE, type CatalogAssistantFacade } from '../../catalog';
import { SELLERS_FACADE, type SellersFacade } from '../../sellers';
import { SUPPORT_CONTACT_FACADE, type SupportContactFacade } from '../../notifications';
import { SEARCH_ASSISTANT_FACADE, type SearchAssistantFacade } from '../../search';
import { SETTINGS_FACADE, type SettingsFacade } from '../../settings';
import { ModelGateway } from '../../../platform/ai/model-gateway';
import type { AppConfig } from '../../../platform/config/app-config';
import { APP_CONFIG } from '../../../platform/config/config.module';
import { LocaleCatalogues } from '../../../platform/i18n/locale-catalogues';
import { ServiceAreaDirectory } from '../../../platform/market-config/service-area-directory';
import { MarketRegistry } from '../../../platform/market-config/market-registry';
import { PrismaService } from '../../../platform/persistence/prisma.service';
import { SubjectRateLimits } from '../../../platform/rate-limit/subject-rate-limits';
import {
  SUBJECT_KEY_SERVICE,
  type SubjectKeyService,
} from '../../../platform/subject-keys/subject-key-service';
import { ASSISTANT_RUNTIME, type AssistantRuntime } from '../application/ports/assistant-runtime';
import {
  ASSISTANT_SETTINGS_REPOSITORY,
  type AssistantSettingsRepository,
} from '../application/ports/assistant-settings.repository';
import { ASSISTANT_TOOLS, type AssistantTools } from '../application/ports/assistant-tools';
import {
  CONVERSATION_REPOSITORY,
  type ConversationRepository,
} from '../application/ports/conversation.repository';
import { GUEST_TOKENS, type GuestTokens } from '../application/ports/guest-tokens';
import { MARKET_CALENDAR, type MarketCalendar } from '../application/ports/market-calendar';
import { MESSAGE_LIMITS, type MessageLimits } from '../application/ports/message-limits';
import { PREVIEW_TOKENS, type PreviewTokens } from '../application/ports/preview-tokens';
import { QUICK_PROMPTS, type QuickPrompts } from '../application/ports/quick-prompts';
import { SPEND_REPOSITORY, type SpendRepository } from '../application/ports/spend.repository';
import { CatalogueQuickPrompts } from './catalogue-quick-prompts';
import { CryptoGuestTokens } from './crypto-guest-tokens';
import { HmacPreviewTokens } from './hmac-preview-tokens';
import { BasketAssistantTools } from './basket-assistant-tools';
import { FacadeAssistantTools } from './facade-assistant-tools';
import { FacadeBasketSources } from './facade-basket-sources';
import { GatewayAssistantRuntime } from './gateway-assistant-runtime';
import { PrismaAssistantSettingsRepository } from './prisma-assistant-settings.repository';
import { PrismaConversationRepository } from './prisma-conversation.repository';
import { PrismaSpendRepository } from './prisma-spend.repository';
import { RegistryMarketCalendar } from './registry-market-calendar';
import { SubjectMessageLimits } from './subject-message-limits';

/** Binds the ports of assistant. Only this layer may reach `PrismaService`, the config and the model. */
export const assistantProviders: readonly FactoryProvider[] = [
  {
    provide: ASSISTANT_SETTINGS_REPOSITORY,
    inject: [PrismaService],
    useFactory: (prisma: PrismaService): AssistantSettingsRepository =>
      new PrismaAssistantSettingsRepository(prisma),
  },
  {
    provide: ASSISTANT_RUNTIME,
    inject: [ModelGateway],
    useFactory: (gateway: ModelGateway): AssistantRuntime => new GatewayAssistantRuntime(gateway),
  },
  {
    provide: CONVERSATION_REPOSITORY,
    inject: [PrismaService, SUBJECT_KEY_SERVICE],
    useFactory: (prisma: PrismaService, keys: SubjectKeyService): ConversationRepository =>
      new PrismaConversationRepository(prisma, keys),
  },
  {
    provide: SPEND_REPOSITORY,
    inject: [PrismaService],
    useFactory: (prisma: PrismaService): SpendRepository => new PrismaSpendRepository(prisma),
  },
  {
    provide: ASSISTANT_TOOLS,
    inject: [
      SEARCH_ASSISTANT_FACADE,
      CATALOG_ASSISTANT_FACADE,
      SUPPORT_CONTACT_FACADE,
      SELLERS_FACADE,
      ServiceAreaDirectory,
      CART_ASSISTANT_FACADE,
      SETTINGS_FACADE,
    ],
    useFactory: (
      search: SearchAssistantFacade,
      catalog: CatalogAssistantFacade,
      support: SupportContactFacade,
      sellers: SellersFacade,
      areas: ServiceAreaDirectory,
      cart: CartAssistantFacade,
      settings: SettingsFacade,
    ): AssistantTools =>
      // `plan_basket` wraps the read tools: the list is searched with the buyer's own context and
      // the Market's cart mode comes from settings (an unreadable store answers multi-store).
      new BasketAssistantTools(
        new FacadeAssistantTools(search, catalog, support, sellers, areas, cart, settings),
        new FacadeBasketSources(search, (context) => settings.cartMode(context)),
      ),
  },
  {
    provide: MESSAGE_LIMITS,
    inject: [SubjectRateLimits],
    useFactory: (counters: SubjectRateLimits): MessageLimits => new SubjectMessageLimits(counters),
  },
  {
    provide: GUEST_TOKENS,
    useFactory: (): GuestTokens => new CryptoGuestTokens(),
  },
  {
    provide: MARKET_CALENDAR,
    inject: [MarketRegistry],
    useFactory: (markets: MarketRegistry): MarketCalendar => new RegistryMarketCalendar(markets),
  },
  {
    provide: PREVIEW_TOKENS,
    inject: [APP_CONFIG],
    useFactory: (config: AppConfig): PreviewTokens =>
      new HmacPreviewTokens(config.assistantPreviewTokenKey),
  },
  {
    provide: QUICK_PROMPTS,
    inject: [MarketRegistry, LocaleCatalogues],
    useFactory: (markets: MarketRegistry, catalogues: LocaleCatalogues): QuickPrompts =>
      new CatalogueQuickPrompts(markets, catalogues),
  },
];
