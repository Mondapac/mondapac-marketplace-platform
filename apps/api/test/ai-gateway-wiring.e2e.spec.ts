import { Module } from '@nestjs/common';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { Test } from '@nestjs/testing';
import { AiModule } from '../src/platform/ai/ai.module';
import { CapabilityRegistry } from '../src/platform/ai/capability-registry';
import { CLOCK } from '../src/platform/clock/clock.module';
import { APP_CONFIG } from '../src/platform/config/config.module';
import { ID_GENERATOR } from '../src/platform/ids/ids.module';
import { MarketRegistry } from '../src/platform/market-config/market-registry';
import { PrismaService } from '../src/platform/persistence/prisma.service';
import { JobRegistry } from '../src/platform/scheduler/job-registry';
import { UNIT_OF_WORK } from '../src/platform/unit-of-work/unit-of-work';
import { createTestApp } from './support/test-app';
import {
  AI_GATEWAY_CONTROLS,
  AI_IN_HOUSE_ROLLBACK_NOTICES,
} from '../src/platform/ai/gateway-controls';
import { SELLER_AI_SWITCH } from '../src/platform/ai/seller-ai-switch';
import { testAppConfig } from './support/test-config';
import type { MarketId } from '@mondapac/shared-kernel';
import { AiModelChoices } from '../src/platform/ai/model-choices';
import { ChangeAiModels } from '../src/modules/settings/application/use-cases/change-ai-models.use-case';
import { ViewAiModels } from '../src/modules/settings/application/use-cases/view-ai-models.use-case';

const MARKET_AU = 'AU' as MarketId;

describe('AI Gateway wiring (platform-ai.md section 4; ADR-0019 decision 7)', () => {
  let app: NestExpressApplication | undefined;
  afterEach(async () => {
    await app?.close();
    app = undefined;
  });

  it('registers every module capability at boot and seals the registry', async () => {
    ({ app } = await createTestApp());
    const registry = app.get(CapabilityRegistry);
    expect(registry.ids()).toEqual([
      'assistant.buyer-chat',
      'catalog.description-writer.admin',
      'catalog.description-writer.seller',
    ]);
    expect(registry.sealed).toBe(true);
    expect(() => registry.register('catalog', [])).toThrow('sealed');
  });

  it.each(['api', 'worker'] as const)(
    'gives settings the model choices of the global AiModule in the %s role (G4b)',
    async (role) => {
      ({ app } = await createTestApp({ env: { APP_ROLE: role } }));
      expect(app.get(ChangeAiModels)).toBeInstanceOf(ChangeAiModels);
      expect(app.get(ViewAiModels)).toBeInstanceOf(ViewAiModels);
      expect(app.get(AiModelChoices).options(MARKET_AU).write).toEqual(expect.any(Array));
    },
  );

  it('fails boot when no module provides the seller switch', async () => {
    @Module({})
    class NoSellerSwitch {}
    @Module({
      providers: [
        { provide: AI_GATEWAY_CONTROLS, useValue: {} },
        { provide: AI_IN_HOUSE_ROLLBACK_NOTICES, useValue: {} },
      ],
      exports: [AI_GATEWAY_CONTROLS, AI_IN_HOUSE_ROLLBACK_NOTICES],
    })
    class GatewayControls {}
    // Everything else AiModule needs is there (as stand-ins), so only the seller switch is missing.
    const present = [UNIT_OF_WORK, CLOCK, ID_GENERATOR, MarketRegistry, PrismaService, JobRegistry];
    @Module({
      providers: [
        { provide: APP_CONFIG, useValue: testAppConfig() },
        ...present.map((token) => ({ provide: token, useValue: {} })),
      ],
      exports: [APP_CONFIG, ...present],
    })
    class Config {}
    const build = Test.createTestingModule({
      imports: [
        { module: Config, global: true },
        AiModule.register(NoSellerSwitch, GatewayControls),
      ],
    }).compile();
    await expect(build).rejects.toThrow(/SELLER_AI_SWITCH|dependencies of the AiGateway/u);
  });

  it('fails boot when no module provides the AI Gateway settings (G4)', async () => {
    @Module({
      providers: [{ provide: SELLER_AI_SWITCH, useValue: {} }],
      exports: [SELLER_AI_SWITCH],
    })
    class SellerSwitch {}
    @Module({})
    class NoGatewayControls {}
    // Everything else AiModule needs is there (as stand-ins), so only the settings port is missing.
    const present = [UNIT_OF_WORK, CLOCK, ID_GENERATOR, MarketRegistry, PrismaService, JobRegistry];
    @Module({
      providers: [
        { provide: APP_CONFIG, useValue: testAppConfig() },
        ...present.map((token) => ({ provide: token, useValue: {} })),
      ],
      exports: [APP_CONFIG, ...present],
    })
    class Config {}
    const build = Test.createTestingModule({
      imports: [
        { module: Config, global: true },
        AiModule.register(SellerSwitch, NoGatewayControls),
      ],
    }).compile();
    await expect(build).rejects.toThrow(/AI_GATEWAY_CONTROLS|dependencies of the AiGateway/u);
  });
  it('fails boot when no module provides the rollback notices (G6e2)', async () => {
    @Module({
      providers: [{ provide: SELLER_AI_SWITCH, useValue: {} }],
      exports: [SELLER_AI_SWITCH],
    })
    class SellerSwitch {}
    @Module({
      providers: [{ provide: AI_GATEWAY_CONTROLS, useValue: {} }],
      exports: [AI_GATEWAY_CONTROLS],
    })
    class ControlsWithoutNotices {}
    const present = [UNIT_OF_WORK, CLOCK, ID_GENERATOR, MarketRegistry, PrismaService, JobRegistry];
    @Module({
      providers: [
        { provide: APP_CONFIG, useValue: testAppConfig() },
        ...present.map((token) => ({ provide: token, useValue: {} })),
      ],
      exports: [APP_CONFIG, ...present],
    })
    class Config {}
    const build = Test.createTestingModule({
      imports: [
        { module: Config, global: true },
        AiModule.register(SellerSwitch, ControlsWithoutNotices),
      ],
    }).compile();
    await expect(build).rejects.toThrow(
      /AI_IN_HOUSE_ROLLBACK_NOTICES|dependencies of the InHouseRollback/u,
    );
  });
});
