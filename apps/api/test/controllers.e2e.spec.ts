import { ModulesContainer } from '@nestjs/core';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { HealthController } from '../src/platform/health/health.controller';
import { isMarketContextExempt } from '../src/platform/market-context/market-context.guard';
import { createTestApp } from './support/test-app';

// W1 of platform-foundations 8.2, due with the first controller outside platform/ (identity
// slice 1d): of the application's own controllers, only HealthController is exempt from the
// Market. Every other controller, the identity sign-up included, is market-scoped.
describe('controllers of the application', () => {
  let app: NestExpressApplication;

  beforeAll(async () => {
    ({ app } = await createTestApp());
  });

  afterAll(async () => {
    await app.close();
  });

  const controllers = (): object[] =>
    [...app.get(ModulesContainer).values()].flatMap((moduleRef) =>
      [...moduleRef.controllers.values()].map((wrapper) => wrapper.metatype as object),
    );

  it('has controllers outside platform/ (the identity sign-up)', () => {
    expect(controllers().map((controller) => (controller as { name: string }).name)).toContain(
      'CustomerSignUpController',
    );
  });

  it('exempts only HealthController from the Market', () => {
    expect(controllers().filter((controller) => isMarketContextExempt(controller))).toEqual([
      HealthController,
    ]);
  });
});
