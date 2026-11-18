import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { DATE_PRESETS } from './date-presets.ts';
import {
  payloadOf as invoicesPayload,
  queryOf as invoicesQuery,
} from './invoices/invoices-saved.ts';
import * as invoices from './invoices/invoices-types.ts';
import { payloadOf as refundsPayload, queryOf as refundsQuery } from './refunds/refunds-saved.ts';
import * as refunds from './refunds/refunds-types.ts';
import {
  payloadOf as shipmentsPayload,
  queryOf as shipmentsQuery,
} from './shipments/shipments-saved.ts';
import * as shipments from './shipments/shipments-types.ts';

// What each list saves, for every tab, every filter field and value, and every sort and direction,
// checked against saved-payloads.fixture.json. The API's saved-view-lists.spec.ts reads the same
// file and asserts that its parsers accept each document unchanged, so a vocabulary or shape
// that drifts on either side fails a test. To regenerate the file after a deliberate change:
// UPDATE_SAVED_PAYLOADS=1 pnpm exec vitest run src/sales/saved-payloads.spec.ts

const FIXTURE = path.join(import.meta.dirname, 'saved-payloads.fixture.json');

interface Spec<Q extends { tab: string; sort: string; direction: string; filters: object }> {
  readonly key: string;
  readonly base: Q;
  readonly tabs: readonly string[];
  readonly sorts: readonly string[];
  readonly filters: Readonly<Record<string, readonly string[]>>;
  readonly payloadOf: (query: Q, paging: 'pages') => object;
  readonly queryOf: (payload: never, paging: 'pages') => Q;
}

const SPECS = {
  shipments: {
    key: 'admin.ordering.shipments',
    base: shipments.DEFAULT_QUERY,
    tabs: shipments.TABS,
    sorts: shipments.SORTS,
    filters: {
      deliveryMethod: shipments.DELIVERY_METHODS,
      attention: shipments.ATTENTIONS,
      paid: DATE_PRESETS,
      shipped: DATE_PRESETS,
    },
    payloadOf: shipmentsPayload,
    queryOf: shipmentsQuery,
  },
  refunds: {
    key: 'admin.ordering.refunds',
    base: refunds.DEFAULT_QUERY,
    tabs: refunds.TABS,
    sorts: refunds.SORTS,
    filters: {
      reason: refunds.REASONS,
      actor: refunds.ACTORS,
      lossBearer: refunds.LOSS_BEARERS,
      ledger: refunds.LEDGERS,
      requested: DATE_PRESETS,
    },
    payloadOf: refundsPayload,
    queryOf: refundsQuery,
  },
  documents: {
    key: 'admin.ordering.documents',
    base: invoices.DEFAULT_QUERY,
    tabs: invoices.TABS,
    sorts: invoices.SORTS,
    filters: { issued: DATE_PRESETS },
    payloadOf: invoicesPayload,
    queryOf: invoicesQuery,
  },
} as const;

type Loose = { tab: string; sort: string; direction: string; filters: object };

function payloadsOf(spec: Spec<Loose>): object[] {
  const out: object[] = [];
  const make = (patch: Partial<Loose>) =>
    out.push(spec.payloadOf({ ...spec.base, ...patch }, 'pages'));
  for (const tab of spec.tabs) make({ tab });
  for (const [field, values] of Object.entries(spec.filters)) {
    for (const value of values) {
      // The Needs attention tab implies "any problem" itself, so the filter is tried on All.
      make({ tab: spec.tabs.find((tab) => tab !== 'attention')!, filters: { [field]: value } });
    }
  }
  for (const sort of spec.sorts) {
    for (const direction of ['asc', 'desc']) make({ sort, direction });
  }
  // Every filter at once, on the last tab, with a changed sort.
  const all = Object.fromEntries(
    Object.entries(spec.filters).map(([field, values]) => [field, values[values.length - 1]]),
  );
  make({
    tab: spec.tabs[spec.tabs.length - 1]!,
    filters: all,
    sort: spec.sorts[spec.sorts.length - 1]!,
    direction: 'asc',
  });
  return out;
}

const built = Object.fromEntries(
  Object.entries(SPECS).map(([name, spec]) => [
    name,
    { listKey: spec.key, payloads: payloadsOf(spec as unknown as Spec<Loose>) },
  ]),
);

describe('the payloads the Sales lists save', () => {
  it('match the checked-in fixture the API parsers are tested with', () => {
    if (process.env['UPDATE_SAVED_PAYLOADS'] === '1') {
      writeFileSync(FIXTURE, `${JSON.stringify(built, null, 2)}\n`);
    }
    expect(JSON.parse(readFileSync(FIXTURE, 'utf8'))).toEqual(JSON.parse(JSON.stringify(built)));
  });

  it.each(Object.entries(SPECS))(
    '%s: every payload opens as the query that saved it',
    (_n, raw) => {
      const spec = raw as unknown as Spec<Loose>;
      for (const payload of payloadsOf(spec)) {
        const query = spec.queryOf(payload as never, 'pages');
        expect(spec.payloadOf(query, 'pages')).toEqual(payload);
      }
    },
  );

  it('never carries a search text or a seller', () => {
    for (const entry of Object.values(built)) {
      for (const payload of entry.payloads) {
        expect(
          Object.keys(payload).every((key) =>
            ['v', 'tab', 'filters', 'sort', 'direction'].includes(key),
          ),
        ).toBe(true);
      }
    }
  });

  it('leaves out a filter the Needs attention tab already implies', () => {
    const query = {
      ...shipments.DEFAULT_QUERY,
      tab: 'attention' as const,
      filters: { attention: 'any' as const },
    };
    expect(shipmentsPayload(query, 'pages')).toEqual({ v: 1, tab: 'attention' });
    expect(shipmentsPayload({ ...query, filters: { attention: 'no-carrier' } }, 'pages')).toEqual({
      v: 1,
      tab: 'attention',
      filters: { attention: 'no-carrier' },
    });
  });
});
