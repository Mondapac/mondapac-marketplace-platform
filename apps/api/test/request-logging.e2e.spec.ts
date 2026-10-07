import { Controller, Get, Logger } from '@nestjs/common';
import type { NestExpressApplication } from '@nestjs/platform-express';
import request from 'supertest';
import { NoMarketContext } from '../src/platform/market-context/no-market-context.decorator';
import { completionLineOf, createTestApp, type LogLine } from './support/test-app';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const SECRET = 'hunter2-request-body-secret';

/** An error shaped like body-parser's: the raw body on `body`, quoted in the message. */
function errorCarryingABody(): Error {
  const error = new SyntaxError(`Unexpected token in "${SECRET}"\nsecond line ${SECRET}`);
  return Object.assign(error, { body: `{"password":"${SECRET}"`, type: 'entity.parse.failed' });
}

/** Test-only: a route that fails with an error whose message quotes user data. */
@NoMarketContext()
@Controller('test/failing')
class FailingController {
  @Get()
  fail(): never {
    throw errorCarryingABody();
  }
}

// Slice 0 item 5 (Security L4): the request logger runs before the body parser. Its own file:
// one application per Jest module registry (see test/support/test-app.ts).
describe('request logging before body parsing (integration)', () => {
  let app: NestExpressApplication;
  let logLines: LogLine[];

  beforeAll(async () => {
    ({ app, logLines } = await createTestApp({ controllers: [FailingController] }));
  });

  afterAll(async () => {
    await app.close();
    // Whatever a case sent or logged, the secret reached no log line.
    expect(logLines.length).toBeGreaterThan(0);
    expect(JSON.stringify(logLines)).not.toContain(SECRET);
  });

  it('logs a malformed JSON body as a 400 with its correlation id, type and length only', async () => {
    const body = `{"password":"${SECRET}"`;
    const response = await request(app.getHttpServer())
      .post('/health?token=secret-query-value')
      .set('content-type', 'application/json')
      .send(body)
      .expect(400);

    const correlationId = response.headers['x-correlation-id'] as string;
    expect(correlationId).toMatch(UUID);
    const line = completionLineOf(logLines, correlationId);
    expect(line.msg).toBe('request errored');
    expect(line.req).toEqual({ method: 'POST', url: '/health', contentLength: body.length });
    expect(line.res).toEqual({ statusCode: 400 });
    expect(line.err).toEqual({
      type: 'SyntaxError',
      kind: 'entity.parse.failed',
      stack: expect.stringMatching(/^\s+at /) as unknown,
    });
    expect(JSON.stringify(logLines)).not.toContain('secret-query-value');
  });

  it('logs a body over the limit as a 413 with its correlation id', async () => {
    const response = await request(app.getHttpServer())
      .post('/health')
      .set('content-type', 'application/json')
      .send(JSON.stringify({ password: SECRET, padding: 'x'.repeat(200 * 1024) }))
      .expect(413);

    const line = completionLineOf(logLines, response.headers['x-correlation-id'] as string);
    expect(line.res).toEqual({ statusCode: 413 });
    expect(line.err).toMatchObject({ type: 'PayloadTooLargeError', kind: 'entity.too.large' });
  });

  it('still parses a valid body and logs the request as completed', async () => {
    const response = await request(app.getHttpServer())
      .post('/health')
      .type('form')
      .send({ password: SECRET })
      .expect(404);

    const line = completionLineOf(logLines, response.headers['x-correlation-id'] as string);
    expect(line.msg).toBe('request completed');
    expect(line).not.toHaveProperty('err');
  });

  it('writes a line logged outside a request as JSON through the same serializers', () => {
    const before = logLines.length;

    new Logger('OutsideRequest').error(errorCarryingABody());

    const line = logLines.slice(before).find((candidate) => candidate.context === 'OutsideRequest');
    expect(line).toBeDefined();
    expect(line).not.toHaveProperty('correlationId');
    expect(line!.err).toEqual({
      type: 'SyntaxError',
      kind: 'entity.parse.failed',
      stack: expect.stringMatching(/^\s+at /) as unknown,
    });
    expect(line!.msg).toBe('SyntaxError');
    expect(line!.err).not.toHaveProperty('body');
  });

  it("logs an unhandled route error by its type: Nest's exception handler line keeps no message", async () => {
    const response = await request(app.getHttpServer()).get('/test/failing').expect(500);

    const correlationId = response.headers['x-correlation-id'] as string;
    expect(completionLineOf(logLines, correlationId).res).toEqual({ statusCode: 500 });
    const handlerLine = logLines.find(
      (line) => line.correlationId === correlationId && line.context === 'ExceptionsHandler',
    );
    expect(handlerLine).toMatchObject({ msg: 'SyntaxError', err: { type: 'SyntaxError' } });
    expect(handlerLine!.err).not.toHaveProperty('body');
  });
});
