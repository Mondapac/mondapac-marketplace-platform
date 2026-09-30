import { Writable } from 'node:stream';
import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { Logger } from 'nestjs-pino';
import request from 'supertest';
import type { App } from 'supertest/types';
import { AppModule } from '../src/app.module';
import { buildOpenApiDocument } from '../src/openapi';
import { loadAppConfig } from '../src/platform/config/app-config';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

interface LogLine {
  correlationId?: string;
  msg?: string;
  req?: Record<string, unknown>;
  res?: Record<string, unknown>;
}

describe('API skeleton (integration)', () => {
  let app: INestApplication<App>;
  let logLines: LogLine[];

  beforeAll(async () => {
    logLines = [];
    const logDestination = new Writable({
      write(chunk: Buffer, _encoding, callback) {
        for (const line of chunk.toString().split('\n').filter(Boolean)) {
          logLines.push(JSON.parse(line) as LogLine);
        }
        callback();
      },
    });

    const moduleRef = await Test.createTestingModule({
      imports: [
        AppModule.register({
          config: loadAppConfig({ NODE_ENV: 'test', HOSTED_MARKETS: 'AU,ZZ' }),
          logDestination,
        }),
      ],
    }).compile();
    app = moduleRef.createNestApplication({ bufferLogs: true });
    app.useLogger(app.get(Logger));
    await app.init();
  });

  afterAll(async () => {
    await app.close();
  });

  beforeEach(() => {
    logLines.length = 0;
  });

  it('GET /health reports liveness', async () => {
    const response = await request(app.getHttpServer()).get('/health').expect(200);

    expect(response.body).toEqual({ status: 'ok' });
  });

  it('generates a correlation id, returns it and logs it', async () => {
    const response = await request(app.getHttpServer()).get('/health').expect(200);

    const correlationId = response.headers['x-correlation-id'];
    expect(correlationId).toMatch(UUID);
    expect(logLines.find((line) => line.msg === 'request completed')).toMatchObject({
      correlationId,
      req: { method: 'GET', url: '/health' },
      res: { statusCode: 200 },
    });
  });

  it('propagates a well-formed correlation id from the caller', async () => {
    const response = await request(app.getHttpServer())
      .get('/health')
      .set('x-correlation-id', 'caller-supplied-0001')
      .expect(200);

    expect(response.headers['x-correlation-id']).toBe('caller-supplied-0001');
    expect(logLines.map((line) => line.correlationId)).toContain('caller-supplied-0001');
  });

  it('replaces a malformed correlation id instead of logging it', async () => {
    const response = await request(app.getHttpServer())
      .get('/health')
      .set('x-correlation-id', 'bad id {with} spaces')
      .expect(200);

    expect(response.headers['x-correlation-id']).toMatch(UUID);
    expect(JSON.stringify(logLines)).not.toContain('bad id');
  });

  it('does not log request headers', async () => {
    await request(app.getHttpServer())
      .get('/health')
      .set('authorization', 'Bearer secret-token-value')
      .expect(200);

    expect(JSON.stringify(logLines)).not.toContain('secret-token-value');
  });

  it('answers unknown routes with 404 and still sets a correlation id', async () => {
    const response = await request(app.getHttpServer()).get('/no-such-route').expect(404);

    expect(response.headers['x-correlation-id']).toMatch(UUID);
  });

  it('documents the health endpoint in OpenAPI', () => {
    const document = buildOpenApiDocument(app);

    expect(document.paths['/health']?.get?.responses).toHaveProperty('200');
  });
});
