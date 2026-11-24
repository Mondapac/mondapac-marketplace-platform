import { describe, expect, it } from 'vitest';
import { guardDelta } from './kpi-format.ts';

const up = { value: 1240, direction: 'up', state: 'ok' } as const;

describe('guardDelta', () => {
  it('keeps the API delta when both periods have a figure', () => {
    expect(guardDelta(up, 5000, 4000)).toEqual(up);
  });

  it('shows a fall to nothing as a drop, never as the stale rise', () => {
    expect(guardDelta(up, 0, 4000)).toEqual({ value: -10000, direction: 'down', state: 'ok' });
  });

  it('is n/a when the previous period is zero or unknown', () => {
    expect(guardDelta(up, 5000, 0)?.state).toBe('na');
    expect(guardDelta(up, 0, 0)?.state).toBe('na');
    expect(guardDelta(up, 5000, undefined)?.state).toBe('na');
  });

  it('has no delta when the API gave none', () => {
    expect(guardDelta(undefined, 5, 5)).toBeUndefined();
  });
});
