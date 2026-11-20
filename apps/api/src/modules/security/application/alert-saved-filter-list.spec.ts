import { SECURITY_ALERTS_SAVED_FILTER_SHARE, SECURITY_VIEW } from '../contracts/permissions';
import { SECURITY_RULES } from '../domain/rules';
import {
  ALERT_LIST_KEY,
  parseAlertFilterPayload,
  SECURITY_ALERT_LISTS,
} from './alert-saved-filter-list';

// The saved filters of the alert list (rule 14): the list registers with `lists` under the centre's
// view key and a protected share key of its own, and its document is closed and canonical. A
// document keeps no key value, no text and no instant (a date is a preset id).

describe('Alert list saved filters', () => {
  const failure = (path: string, code: string) => ({
    ok: false,
    error: { code: 'validation.failed', fields: [{ path, code }] },
  });
  const rule = SECURITY_RULES[0]!.code;

  it('registers the list as an admin list under the view key, with its own share key', () => {
    expect(SECURITY_ALERT_LISTS).toHaveLength(1);
    expect(SECURITY_ALERT_LISTS[0]).toMatchObject({
      listKey: ALERT_LIST_KEY,
      population: 'admin',
      viewKey: SECURITY_VIEW.key,
      shareKey: SECURITY_ALERTS_SAVED_FILTER_SHARE.key,
    });
  });

  it('keeps the share key a protected platform key apart from the keys that read and respond', () => {
    expect(SECURITY_ALERTS_SAVED_FILTER_SHARE.key).toBe('security.alerts-saved-filter.share');
    expect(SECURITY_ALERTS_SAVED_FILTER_SHARE.protected).toBe(true);
    expect(SECURITY_ALERTS_SAVED_FILTER_SHARE.scope).toBe('platform');
  });

  it('keeps a view alone as the smallest document', () => {
    expect(parseAlertFilterPayload({ v: 1, view: 'open' })).toEqual({
      ok: true,
      value: { v: 1, view: 'open' },
    });
  });

  it('canonicalises severities (once each, catalogue order) and drops unset parts', () => {
    expect(
      parseAlertFilterPayload({
        v: 1,
        view: 'all',
        filters: {
          severities: ['s3', 's1', 's3'],
          rule,
          keyType: 'account',
          opened: 'last-7-days',
          minEvents: 5,
        },
        sort: 'severity',
        direction: 'desc',
      }),
    ).toEqual({
      ok: true,
      value: {
        v: 1,
        view: 'all',
        filters: {
          severities: ['s1', 's3'],
          rule,
          keyType: 'account',
          opened: 'last-7-days',
          minEvents: 5,
        },
        sort: 'severity',
        direction: 'desc',
      },
    });
    expect(
      parseAlertFilterPayload({
        v: 1,
        view: 'critical',
        filters: { severities: [], rule: '', keyType: null, opened: '', minEvents: null },
        sort: '',
      }),
    ).toEqual({ ok: true, value: { v: 1, view: 'critical' } });
  });

  it('never keeps a key value, a text or an instant', () => {
    expect(parseAlertFilterPayload({ v: 1, view: 'all', filters: { keyValue: 'x' } })).toEqual(
      failure('payload.filters.keyValue', 'unknown'),
    );
    expect(parseAlertFilterPayload({ v: 1, view: 'all', filters: { from: '2026-01-01' } })).toEqual(
      failure('payload.filters.from', 'unknown'),
    );
    expect(parseAlertFilterPayload({ v: 1, view: 'all', q: 'x' })).toEqual(
      failure('payload.q', 'unknown'),
    );
  });

  it('refuses what the list would refuse, naming the field', () => {
    expect(parseAlertFilterPayload('x')).toEqual(failure('payload', 'type'));
    expect(parseAlertFilterPayload({ v: 2, view: 'all' })).toEqual(failure('payload.v', 'value'));
    expect(parseAlertFilterPayload({ v: 1, view: 5 })).toEqual(failure('payload.view', 'type'));
    expect(parseAlertFilterPayload({ v: 1, view: 'held' })).toEqual(
      failure('payload.view', 'value'),
    );
    expect(parseAlertFilterPayload({ v: 1, view: 'all', filters: 'x' })).toEqual(
      failure('payload.filters', 'type'),
    );
    expect(parseAlertFilterPayload({ v: 1, view: 'all', filters: { severities: 's1' } })).toEqual(
      failure('payload.filters.severities', 'type'),
    );
    expect(parseAlertFilterPayload({ v: 1, view: 'all', filters: { severities: ['s9'] } })).toEqual(
      failure('payload.filters.severities', 'value'),
    );
    expect(parseAlertFilterPayload({ v: 1, view: 'all', filters: { rule: 'nope' } })).toEqual(
      failure('payload.filters.rule', 'value'),
    );
    expect(parseAlertFilterPayload({ v: 1, view: 'all', filters: { keyType: 'user' } })).toEqual(
      failure('payload.filters.keyType', 'value'),
    );
    expect(
      parseAlertFilterPayload({ v: 1, view: 'all', filters: { opened: 'next-week' } }),
    ).toEqual(failure('payload.filters.opened', 'value'));
    expect(parseAlertFilterPayload({ v: 1, view: 'all', filters: { minEvents: '5' } })).toEqual(
      failure('payload.filters.minEvents', 'type'),
    );
    for (const minEvents of [0, 1.5, 1_000_001]) {
      expect(parseAlertFilterPayload({ v: 1, view: 'all', filters: { minEvents } })).toEqual(
        failure('payload.filters.minEvents', 'value'),
      );
    }
    expect(parseAlertFilterPayload({ v: 1, view: 'all', sort: 'name' })).toEqual(
      failure('payload.sort', 'value'),
    );
    expect(parseAlertFilterPayload({ v: 1, view: 'all', direction: 'up' })).toEqual(
      failure('payload.direction', 'value'),
    );
  });
});
