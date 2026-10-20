import type { FactoryProvider } from '@nestjs/common';
import type { AppConfig } from '../../../platform/config/app-config';
import { APP_CONFIG } from '../../../platform/config/config.module';
import { PrismaService } from '../../../platform/persistence/prisma.service';
import { ASSISTANT_RUNTIME, type AssistantRuntime } from '../application/ports/assistant-runtime';
import {
  ASSISTANT_SETTINGS_REPOSITORY,
  type AssistantSettingsRepository,
} from '../application/ports/assistant-settings.repository';
import { ConfigAssistantRuntime } from './config-assistant-runtime';
import { PrismaAssistantSettingsRepository } from './prisma-assistant-settings.repository';

/** Binds the ports of assistant. Only this layer may reach `PrismaService` and the config. */
export const assistantProviders: readonly FactoryProvider[] = [
  {
    provide: ASSISTANT_SETTINGS_REPOSITORY,
    inject: [PrismaService],
    useFactory: (prisma: PrismaService): AssistantSettingsRepository =>
      new PrismaAssistantSettingsRepository(prisma),
  },
  {
    provide: ASSISTANT_RUNTIME,
    inject: [APP_CONFIG],
    useFactory: (config: AppConfig): AssistantRuntime => new ConfigAssistantRuntime(config),
  },
];
