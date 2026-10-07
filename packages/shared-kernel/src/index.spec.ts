import * as kernel from './index';
import * as testing from './testing';

describe('the public surface of the kernel', () => {
  it('exports exactly the slice 0 and slice 1b names from the main entry', () => {
    expect(Object.keys(kernel).sort()).toEqual([
      'MAX_AGGREGATE_VERSION',
      'Temporal',
      'checkAggregateVersion',
      'defineEvent',
      'describeEventDefinition',
      'encodePayload',
      'err',
      'eventField',
      'isMinted',
      'mintMarketContext',
      'ok',
      'parseCorrelationId',
      'parseId',
      'parseMarketId',
      'parseTenantId',
      'uuidV7',
    ]);
  });

  it('has no default export', () => {
    expect(kernel).not.toHaveProperty('default');
    expect(testing).not.toHaveProperty('default');
  });

  it('does not export the internal mint function', () => {
    expect(kernel).not.toHaveProperty('mint');
    expect(testing).not.toHaveProperty('mint');
  });

  it('keeps the fakes and builders on the testing entry only', () => {
    expect(Object.keys(testing).sort()).toEqual([
      'FixedClock',
      'SequenceIdGenerator',
      'testMarketContext',
    ]);
    for (const name of Object.keys(testing)) expect(kernel).not.toHaveProperty(name);
  });
});
