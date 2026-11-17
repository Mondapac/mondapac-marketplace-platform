import { describe, expect, it } from 'vitest';
import { refusalOf, bulkReasonKey } from './errors.ts';
import {
  DEFAULT_COLUMNS,
  DEFAULT_QUERY,
  NO_FILTERS,
  cleanColumns,
  countText,
  daysOverdue,
  filterCount,
  humanKind,
  matchingBody,
  queryFromSearch,
  queryString,
  searchOf,
  subjectHref,
  type Query,
} from './types.ts';

const ZONE = 'Australia/Brisbane';
const query = (patch: Partial<Query>): Query => ({ ...DEFAULT_QUERY, ...patch });
const params = (text: string) => Object.fromEntries(new URLSearchParams(text));

describe('queryString', () => {
  it('asks for the view, newest first, and a page', () => {
    expect(params(queryString(query({ view: 'all-open' }), ZONE, 'pages', null))).toEqual({
      view: 'all-open',
      sort: 'applied',
      direction: 'desc',
      pageSize: '25',
      page: '1',
    });
  });

  it('sends a cursor and no page in cursor mode', () => {
    const text = queryString(query({ page: 3 }), ZONE, 'prev-next', 'abc_-1');
    expect(params(text)['cursor']).toBe('abc_-1');
    expect(params(text)['page']).toBeUndefined();
  });

  it('joins the values of a filter and reads the days on the admin clock, last day included', () => {
    const text = queryString(
      query({
        q: 'SR-1042',
        filters: {
          ...NO_FILTERS,
          area: ['money', 'people'],
          risk: ['high'],
          status: ['open'],
          from: '2026-11-01',
          to: '2026-11-10',
          overdue: true,
          subjectKind: 'system-requests.policy-area',
          subjectRef: 'money',
        },
      }),
      ZONE,
      'pages',
      null,
    );
    expect(params(text)).toMatchObject({
      q: 'SR-1042',
      area: 'money,people',
      risk: 'high',
      status: 'open',
      // Brisbane is UTC+10 all year: midnight is 14:00 the day before, UTC.
      appliedFrom: '2026-10-31T14:00:00.000Z',
      appliedTo: '2026-11-10T14:00:00.000Z',
      overdue: 'true',
      subjectKind: 'system-requests.policy-area',
      subjectRef: 'money',
    });
  });

  it('leaves out a status that the view already fixes and the overdue flag of the Overdue view', () => {
    const text = queryString(
      query({
        view: 'approved',
        filters: { ...NO_FILTERS, status: ['open'], overdue: true },
      }),
      ZONE,
      'pages',
      null,
    );
    expect(params(text)['status']).toBeUndefined();
    const overdue = queryString(
      query({ view: 'overdue', filters: { ...NO_FILTERS, overdue: true } }),
      ZONE,
      'pages',
      null,
    );
    expect(params(overdue)['overdue']).toBeUndefined();
  });

  it('builds the body of "approve all matching" from the same filter, without sort or paging', () => {
    const body = matchingBody(
      query({ view: 'all-open', q: 'rate', filters: { ...NO_FILTERS, risk: ['low'] } }),
      ZONE,
    );
    expect(body).toEqual({ view: 'all-open', q: 'rate', risk: 'low' });
  });
});

describe('the address of the queue', () => {
  it('round-trips a query and drops what it does not know', () => {
    const original = query({
      view: 'overdue',
      q: 'x',
      sort: 'due',
      direction: 'desc',
      pageSize: 50,
      filters: { ...NO_FILTERS, area: ['money'], risk: ['low', 'high'], from: '2026-11-01' },
    });
    expect(queryFromSearch(searchOf(original))).toEqual(original);
    const hostile = queryFromSearch(
      'view=hacked&area=money,evil&risk=<b>&sort=drop&pageSize=7&subjectKind=notakind&from=yesterday',
    );
    expect(hostile.view).toBe(DEFAULT_QUERY.view);
    expect(hostile.filters).toEqual({ ...NO_FILTERS, area: ['money'] });
    expect(hostile.sort).toBe('applied');
    expect(hostile.pageSize).toBe(25);
  });

  it('keeps a deep link to one subject', () => {
    const linked = queryFromSearch(
      'subjectKind=wallet.market-status&subjectRef=wallet-settings&view=all',
    );
    expect(linked.view).toBe('all');
    expect(linked.filters.subjectKind).toBe('wallet.market-status');
    expect(linked.filters.subjectRef).toBe('wallet-settings');
    expect(filterCount(linked.filters)).toBe(1);
  });
});

describe('display rules', () => {
  const format = (value: number) => value.toLocaleString('en-AU');

  it('shows 10,000+ at the cap and the number below it', () => {
    expect(countText(10_000, format)).toBe('10,000+');
    expect(countText(9_999, format)).toBe('9,999');
    expect(countText(0, format)).toBe('0');
  });

  it('counts whole days overdue on the admin clock', () => {
    const now = new Date('2026-11-16T03:00:00.000Z');
    expect(daysOverdue('2026-11-13T03:00:00.000Z', now, ZONE)).toBe(3);
    expect(daysOverdue('2026-11-16T01:00:00.000Z', now, ZONE)).toBe(1);
    expect(daysOverdue('2026-11-17T03:00:00.000Z', now, ZONE)).toBe(0);
  });

  it('keeps known columns in their stored order and falls back to the defaults', () => {
    expect(cleanColumns(undefined)).toEqual(DEFAULT_COLUMNS);
    expect(cleanColumns(['comments', 'bogus', 'subject', 'comments'])).toEqual([
      'comments',
      'subject',
    ]);
    expect(cleanColumns([])).toEqual([]);
  });

  it('names a subject kind it does not know from its own words, and links the ones it does', () => {
    expect(humanKind('wallet.market-status')).toBe('Market status');
    expect(subjectHref('wallet.market-status', 'wallet-settings')).toBe('/settings/wallet');
    expect(
      subjectHref('commission-payouts.commission-rate', '0190a000-0000-7000-8000-000000000001'),
    ).toBe('/sellers/0190a000-0000-7000-8000-000000000001');
    expect(subjectHref('commission-payouts.commission-rate', 'not-an-id')).toBeNull();
    expect(subjectHref('unknown.kind', 'x')).toBeNull();
  });
});

describe('refusals', () => {
  const failure = (code: string, status: number, details?: { newerRequestId?: string | null }) => ({
    status,
    code,
    ...(details === undefined ? {} : { details }),
  });

  it('maps both own codes to the same message', () => {
    expect(refusalOf(failure('system-requests.own-request', 403)).key).toBe('own');
    expect(refusalOf(failure('system-requests.own-subject', 403)).key).toBe('own');
  });

  it('keeps the newer request of a changed-since refusal', () => {
    expect(
      refusalOf(failure('system-requests.changed-since', 409, { newerRequestId: 'abc' })),
    ).toMatchObject({ tone: 'attention', newerRequestId: 'abc', refetch: true });
    expect(
      refusalOf(failure('system-requests.changed-since', 409, { newerRequestId: null })),
    ).not.toHaveProperty('newerRequestId');
  });

  it('offers a retry for an unavailable revert and a network failure, and a reload for csrf', () => {
    expect(refusalOf(failure('system-requests.revert-unavailable', 503))).toMatchObject({
      retry: true,
    });
    expect(refusalOf(failure('network', 0))).toMatchObject({ key: 'network', retry: true });
    expect(refusalOf(failure('request.csrf', 403))).toMatchObject({ reload: true });
    expect(refusalOf(failure('second-factor.enrolment-required', 403))).toMatchObject({
      enrol: true,
    });
  });

  it('words a bulk refusal with or without the module prefix, and an unknown code as other', () => {
    expect(bulkReasonKey('system-requests.not-low-risk')).toBe('not-low-risk');
    expect(bulkReasonKey('decided')).toBe('decided');
    expect(bulkReasonKey('system-requests.own-subject')).toBe('own');
    expect(bulkReasonKey('boom')).toBe('other');
  });
});
