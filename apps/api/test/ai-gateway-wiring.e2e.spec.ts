import { Module } from '@nestjs/common';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { Test } from '@nestjs/testing';
import { AiModule } from '../src/platform/ai/ai.module';
import { CapabilityRegistry } from '../src/platform/ai/capability-registry';
import { APP_CONFIG } from '../src/platform/config/config.module';
import { createTestApp } from './support/test-app';
import { testAppConfig } from './support/test-config';

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

  it('fails boot when no module provides the seller switch', async () => {
    @Module({})
    class NoSellerSwitch {}
    @Module({
      providers: [{ provide: APP_CONFIG, useValue: testAppConfig() }],
      exports: [APP_CONFIG],
    })
    class Config {}
    const build = Test.createTestingModule({
      imports: [{ module: Config, global: true }, AiModule.register(NoSellerSwitch)],
    }).compile();
    await expect(build).rejects.toThrow(/SELLER_AI_SWITCH|dependencies of the AiGateway/u);
  });
});
