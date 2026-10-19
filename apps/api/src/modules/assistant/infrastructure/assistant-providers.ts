import type { FactoryProvider } from '@nestjs/common';
import { CATALOG_ASSISTANT_FACADE, type CatalogAssistantFacade } from '../../catalog';
import { SUPPORT_CONTACT_FACADE, type SupportContactFacade } from '../../notifications';
import { SEARCH_ASSISTANT_FACADE, type SearchAssistantFacade } from '../../search';
import { ModelGateway } from '../../../platform/ai/model-gateway';
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
import { SPEND_REPOSITORY, type SpendRepository } from '../application/ports/spend.repository';
import { CryptoGuestTokens } from './crypto-guest-tokens';
import { FacadeAssistantTools } from './facade-assistant-tools';
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
    inject: [SEARCH_ASSISTANT_FACADE, CATALOG_ASSISTANT_FACADE, SUPPORT_CONTACT_FACADE],
    useFactory: (
      search: SearchAssistantFacade,
      catalog: CatalogAssistantFacade,
      support: SupportContactFacade,
    ): AssistantTools => new FacadeAssistantTools(search, catalog, support),
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
];
