import type { NestExpressApplication } from '@nestjs/platform-express';
import request from 'supertest';
import { MarketEchoController } from './support/market-test.controllers';
import { createTestApp } from './support/test-app';

// Its own file: one application per Jest module registry (see test/support/test-app.ts).
describe('API docs (integration)', () => {
  let app: NestExpressApplication;

  beforeAll(async () => {
    ({ app } = await createTestApp({
      env: { API_DOCS_ENABLED: 'true', LOG_LEVEL: 'silent' },
      controllers: [MarketEchoController],
    }));
  });

  afterAll(async () => {
    await app.close();
  });

  it('serves Swagger UI and the document when API_DOCS_ENABLED is true, without x-market-id', async () => {
    await request(app.getHttpServer()).get('/docs').expect(200);
    const response = await request(app.getHttpServer()).get('/docs-json').expect(200);

    expect(response.body).toHaveProperty(['paths', '/health/ready']);
  });

  it('documents x-market-id on market-scoped operations and not on /health', async () => {
    const response = await request(app.getHttpServer()).get('/docs-json').expect(200);

    const document = response.body as {
      paths: Record<string, { get: { parameters?: { name: string; in: string }[] } }>;
    };
    expect(document.paths['/test/market']?.get.parameters).toContainEqual(
      expect.objectContaining({ name: 'x-market-id', in: 'header', required: true }),
    );
    expect(document.paths['/health']?.get.parameters ?? []).not.toContainEqual(
      expect.objectContaining({ name: 'x-market-id' }),
    );
  });
});
