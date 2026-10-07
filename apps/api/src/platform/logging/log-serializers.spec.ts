import { Writable } from 'node:stream';
import { pino, type Logger } from 'pino';
import { LOG_HOOKS, LOG_SERIALIZERS } from './log-serializers';

const SECRET = 'secret-value-0001';

function capturingLogger(): { logger: Logger; lines: Record<string, unknown>[] } {
  const lines: Record<string, unknown>[] = [];
  const stream = new Writable({
    write(chunk: Buffer, _encoding, callback) {
      lines.push(JSON.parse(chunk.toString()) as Record<string, unknown>);
      callback();
    },
  });
  const logger = pino({ serializers: LOG_SERIALIZERS, hooks: LOG_HOOKS }, stream);
  return { logger, lines };
}

describe('LOG_SERIALIZERS.req', () => {
  it('keeps the method and the path, without the query string', () => {
    expect(
      LOG_SERIALIZERS.req({ method: 'GET', url: `/a/b?token=${SECRET}`, headers: {} }),
    ).toEqual({
      method: 'GET',
      url: '/a/b',
    });
  });

  it('adds the declared content length, and nothing else from the headers', () => {
    const logged = LOG_SERIALIZERS.req({
      method: 'POST',
      url: '/a',
      headers: { 'content-length': '42', authorization: `Bearer ${SECRET}` },
    });

    expect(logged).toEqual({ method: 'POST', url: '/a', contentLength: 42 });
  });

  it.each(['', 'abc', '-1', '1e3', '12345678901234567', `42 ${SECRET}`])(
    'drops a content length that is not a plain number (%p)',
    (value) => {
      expect(
        LOG_SERIALIZERS.req({ method: 'POST', url: '/a', headers: { 'content-length': value } }),
      ).not.toHaveProperty('contentLength');
    },
  );
});

describe('LOG_SERIALIZERS.err', () => {
  function bodyParserLikeError(): Error {
    const error = new SyntaxError(`Unexpected token in "${SECRET}"\n${SECRET}`);
    return Object.assign(error, { body: SECRET, type: 'entity.parse.failed', status: 400 });
  }

  it('keeps the type, the reason and the stack frames, never the message or the body', () => {
    const logged = LOG_SERIALIZERS.err(bodyParserLikeError());

    expect(Object.keys(logged).sort()).toEqual(['kind', 'stack', 'type']);
    expect(logged).toMatchObject({ type: 'SyntaxError', kind: 'entity.parse.failed' });
    expect(logged.stack?.split('\n').every((line) => /^\s+at /.test(line))).toBe(true);
    expect(JSON.stringify(logged)).not.toContain(SECRET);
  });

  it('reads the error from `raw` when pino-std-serializers has already copied it', () => {
    const error = bodyParserLikeError();
    const copied = { type: 'SyntaxError', message: error.message, body: SECRET, raw: error };

    expect(LOG_SERIALIZERS.err(copied)).toEqual(LOG_SERIALIZERS.err(error));
  });

  it('keeps a code that looks like one and drops one that carries text', () => {
    expect(LOG_SERIALIZERS.err(Object.assign(new Error('x'), { code: 'P2002' }))).toMatchObject({
      code: 'P2002',
    });
    expect(
      LOG_SERIALIZERS.err(Object.assign(new Error('x'), { code: `Key (email)=(${SECRET})` })),
    ).not.toHaveProperty('code');
  });

  it.each([SECRET, 42, null, undefined, { message: SECRET }])(
    'logs a thrown value that is not an error as a bare Error (%p)',
    (value) => {
      expect(LOG_SERIALIZERS.err(value)).toEqual({ type: 'Error' });
    },
  );
});

describe('LOG_HOOKS.logMethod', () => {
  it("replaces the message pino takes from an error with the error's type", () => {
    const { logger, lines } = capturingLogger();

    logger.error(new TypeError(SECRET));
    logger.error({ err: new RangeError(SECRET), context: 'Probe' });

    expect(lines.map((line) => line.msg)).toEqual(['TypeError', 'RangeError']);
    expect(JSON.stringify(lines)).not.toContain(SECRET);
  });

  it('keeps a message the code passes, and lines without an error', () => {
    const { logger, lines } = capturingLogger();

    logger.error({ err: new Error(SECRET) }, 'mail delivery failed');
    logger.info({ context: 'Probe' });
    logger.info('started');

    expect(lines.map((line) => line.msg)).toEqual(['mail delivery failed', undefined, 'started']);
  });
});
