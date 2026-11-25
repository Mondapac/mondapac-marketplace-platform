import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../api/client.ts', () => ({ callApi: vi.fn() }));

import { callApi } from '../api/client.ts';
import { STEP_UP_CANCELLED, type GuardedCall } from '../step-up/step-up.tsx';
import { sendSizeWrites } from './size-writes.ts';
import type { TableRow, Write } from './variants-table-logic.ts';

const call = vi.mocked(callApi);
const row = (id: string): TableRow => ({
  variantId: id,
  label: id,
  price: {
    variantId: id,
    seriesVersion: 3,
    currency: 'AUD',
    inForce: { amount: '100', effectiveFrom: '2026-01-01T00:00:00Z' },
    held: null,
    special: null,
    heldSpecial: null,
    retired: false,
  },
  stock: { s1: { variantId: id, sourceId: 's1', onHand: 1, held: 0, version: 7, retired: false } },
});
const ROWS = [row('v1'), row('v2')];
const messages = {
  throttledCell: 'slow down',
  price: (problem: string) => `price ${problem}`,
  stock: (problem: string) => `stock ${problem}`,
};
const ok = (body: unknown) => Promise.resolve({ ok: true as const, status: 200, body });
const refused = (status: number, code: string, details?: unknown) =>
  Promise.resolve({ ok: false as const, failure: { status, code, details } }) as never;
const send = (writes: Write[], guarded: GuardedCall, versions = {}) =>
  sendSizeWrites({
    offerId: 'o1',
    rows: ROWS,
    writes,
    currency: 'AUD',
    versions,
    csrfToken: 'csrf',
    guarded,
    messages,
  });
const price = (variantId: string, amount = '200'): Write => ({ kind: 'price', variantId, amount });
const stock = (variantId: string, onHand = 5): Write => ({
  kind: 'stock',
  variantId,
  sourceId: 's1',
  onHand,
});

beforeEach(() => call.mockReset());

describe('sendSizeWrites', () => {
  it('sends each write with the version it knows, and counts what was saved', async () => {
    const guarded = vi.fn(() => ok({ seriesVersion: 4 })) as unknown as GuardedCall;
    call.mockImplementation(() => ok({ version: 8 }));
    const out = await send([price('v1'), stock('v2')], guarded, { 'price:v1': 9 });
    expect(guarded).toHaveBeenCalledWith(
      'PUT',
      'pricing/seller/offers/o1/variants/v1/regular-price',
      { amount: '200', currency: 'AUD', expectedVersion: 9 },
      'csrf',
    );
    expect(call).toHaveBeenCalledWith(
      'PUT',
      'inventory/seller/offers/o1/variants/v2/sources/s1/stock',
      { onHand: 5, expectedVersion: 7 },
      'csrf',
    );
    expect(out).toMatchObject({
      done: 2,
      stopped: false,
      signedOut: false,
      savedPrices: ['v1'],
      savedStocks: ['v2:s1'],
      seen: { 'price:v1': 4, 'stock:v2:s1': 8 },
    });
  });

  it('marks a refused cell and goes on with the rest', async () => {
    const guarded = vi.fn(() => refused(422, 'validation.failed')) as unknown as GuardedCall;
    call.mockImplementation(() => ok({ version: 8 }));
    const out = await send([price('v1'), stock('v2')], guarded);
    expect(Object.keys(out.found)).toEqual(['v1']);
    expect(out.done).toBe(1);
  });

  it('stops at "too many requests" and keeps the rest as drafts', async () => {
    const guarded = vi.fn(() =>
      refused(429, 'request.throttled', { retryAfterSeconds: 90 }),
    ) as unknown as GuardedCall;
    const out = await send([price('v1'), stock('v2')], guarded);
    expect(out).toMatchObject({ stopped: true, waitSeconds: 90, done: 0 });
    expect(out.found).toEqual({ v1: 'slow down' });
    expect(call).not.toHaveBeenCalled();
  });

  it('stops quietly when the two-step code is cancelled', async () => {
    const guarded = vi.fn(() => refused(0, STEP_UP_CANCELLED)) as unknown as GuardedCall;
    const out = await send([price('v1'), price('v2')], guarded);
    expect(out).toMatchObject({ stopped: true, waitSeconds: null, done: 0, found: {} });
    expect(guarded).toHaveBeenCalledTimes(1);
  });

  it('says when the session ended', async () => {
    call.mockImplementation(() => refused(401, 'session.invalid'));
    const out = await send([stock('v1'), stock('v2')], vi.fn());
    expect(out.signedOut).toBe(true);
    expect(call).toHaveBeenCalledTimes(1);
  });
});
