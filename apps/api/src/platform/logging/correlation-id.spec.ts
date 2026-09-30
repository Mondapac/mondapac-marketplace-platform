import { resolveCorrelationId } from './correlation-id';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

describe('resolveCorrelationId', () => {
  it('keeps a well-formed incoming id', () => {
    expect(resolveCorrelationId('req-12345678')).toBe('req-12345678');
  });

  it('uses the first value when the header is repeated', () => {
    expect(resolveCorrelationId(['first-id-0001', 'second-id-0002'])).toBe('first-id-0001');
  });

  it('generates a new id when none is supplied', () => {
    expect(resolveCorrelationId(undefined)).toMatch(UUID);
  });

  it.each(['short', 'has space inside', 'line\nbreak-attempt', 'x'.repeat(129), '{"json":1}'])(
    'replaces the unsafe id %p',
    (incoming) => {
      expect(resolveCorrelationId(incoming)).toMatch(UUID);
    },
  );
});
