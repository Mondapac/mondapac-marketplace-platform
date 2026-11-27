import type { NestExpressApplication } from '@nestjs/platform-express';
import request from 'supertest';
import { createTestApp } from './support/test-app';

// The storefront's Create account form reads the request Market's password rule (identity design
// 6.5; `ux.md` A2). Public: no session, no cookie, nothing about an account. Two Market fixtures
// with different rules (AU 15 to 128, ZZ 16 to 100), so a number in code would fail one of them.

const PATH = '/identity/customer/password-rules';

describe('GET /identity/customer/password-rules (integration)', () => {
  let app: NestExpressApplication;

  afterEach(async () => {
    await app.close();
  });

  it.each([
    ['AU', 15, 128],
    ['ZZ', 16, 100],
  ])('answers the %s Market its own rule, not cached', async (market, minLength, maxLength) => {
    ({ app } = await createTestApp());

    const response = await request(app.getHttpServer()).get(PATH).set('x-market-id', market);

    expect(response.status).toBe(200);
    expect(response.body).toEqual({ minLength, maxLength });
    expect(response.headers['cache-control']).toBe('no-store');
    expect(response.headers['set-cookie']).toBeUndefined();
  });

  it('refuses a request without x-market-id', async () => {
    ({ app } = await createTestApp());

    const response = await request(app.getHttpServer()).get(PATH);

    expect(response.status).toBeGreaterThanOrEqual(400);
    expect(response.body).not.toHaveProperty('minLength');
  });

  it('is in the OpenAPI document with the x-market-id header', async () => {
    ({ app } = await createTestApp({ env: { API_DOCS_ENABLED: 'true' } }));

    const response = await request(app.getHttpServer()).get('/docs-json').expect(200);

    const operation = (
      response.body as {
        paths: Record<string, { get?: { parameters?: unknown[]; responses?: object } }>;
      }
    ).paths[PATH]?.get;
    expect(operation?.parameters).toContainEqual(
      expect.objectContaining({ name: 'x-market-id', in: 'header', required: true }),
    );
    expect(Object.keys(operation?.responses ?? {})).toContain('200');
  });
});
