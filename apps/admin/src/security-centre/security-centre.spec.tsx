// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { NextIntlClientProvider } from 'next-intl';
import type { ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import messages from '../../messages/en.json';
import { expectToast, toastsOf } from '../../test/toast-spy.ts';

vi.mock('../api/client.ts', () => ({ callApi: vi.fn() }));

import { callApi, type ApiResult } from '../api/client.ts';
import { AlertDetailView } from './alert-detail.tsx';
import { AlertsList, mergeRefresh } from './alerts-list.tsx';
import { CriticalAlertsBadge } from './critical-badge.tsx';
import {
  noteLength,
  rulesStale,
  stateQuery,
  type AlertDetail,
  type AlertSummary,
  type Summary,
} from './types.ts';

const call = vi.mocked(callApi);
const wrap = (node: ReactNode) => (
  <NextIntlClientProvider locale="en-AU" messages={messages} timeZone="UTC">
    {node}
  </NextIntlClientProvider>
);
const ID = '0190a000-0000-7000-8000-0000000000a1';
const NOW = new Date().toISOString();

const row = (over: Partial<AlertSummary> = {}): AlertSummary => ({
  id: ID,
  rule: 'auth.brute-force',
  title: 'Many failed sign-ins for one account',
  severity: 's2',
  state: 'open',
  keyType: 'account',
  keyLabel: 'acc-1',
  eventCount: 12,
  firstEventAt: NOW,
  lastEventAt: NOW,
  openedAt: NOW,
  acknowledgedAt: null,
  acknowledgedByName: null,
  resolvedAt: null,
  nextNotifyAt: null,
  version: 3,
  ...over,
});
const detail = (over: Partial<AlertDetail> = {}): AlertDetail => ({
  ...row(),
  keyValue: 'acc-1',
  notifyStep: 1,
  acknowledgedBy: null,
  resolvedBy: null,
  resolvedByName: null,
  viewerResolvesCritical: false,
  resolution: null,
  resolutionNote: null,
  deliveries: [],
  ...over,
});
const summary = (s1 = 0): Summary => ({
  live: { s1, s2: 1, s3: 0, s4: 0 },
  rulesLastRanAt: NOW,
  onCall: { code: 'hassan', name: 'Hassan R.' },
});
const ok = <T,>(body: T) => ({ ok: true as const, status: 200, body });
const fail = (status: number, code = 'x') => ({ ok: false as const, failure: { status, code } });

beforeEach(() => {
  vi.clearAllMocks();
  HTMLDialogElement.prototype.showModal = function showModal() {
    this.setAttribute('open', '');
  };
  HTMLDialogElement.prototype.close = function close() {
    this.removeAttribute('open');
  };
});
afterEach(cleanup);

/** usePoll reads again when the tab becomes visible: the same path as the 30 s timer. */
const poll = () => {
  Object.defineProperty(document, 'visibilityState', { value: 'visible', configurable: true });
  document.dispatchEvent(new Event('visibilitychange'));
};

describe('security centre helpers', () => {
  it('maps the page filter to the API state filter', () => {
    expect(stateQuery('live')).toBe('open,acknowledged');
    expect(stateQuery('all')).toBe('');
    expect(stateQuery('resolved')).toBe('resolved');
  });

  it('calls the rules stale when they never ran or ran over five minutes ago', () => {
    const now = Date.parse('2026-11-15T05:00:00Z');
    expect(rulesStale(null, now)).toBe(true);
    expect(rulesStale('2026-11-15T04:54:00Z', now)).toBe(true);
    expect(rulesStale('2026-11-15T04:58:00Z', now)).toBe(false);
  });

  it('merges a refresh in the API order and keeps rows loaded with Load more', () => {
    const many = Array.from({ length: 52 }, (_, n) => row({ id: `id-${String(n)}` }));
    const fresh = [row({ id: 'new-s1', severity: 's1' }), ...many.slice(0, 49)];
    const merged = mergeRefresh(many, fresh);
    expect(merged[0]?.id).toBe('new-s1');
    expect(merged.map((alert) => alert.id).slice(-2)).toEqual(['id-50', 'id-51']);
    expect(new Set(merged.map((alert) => alert.id)).size).toBe(merged.length);
    // A first-page row that left the page (resolved elsewhere) leaves the list.
    expect(merged.some((alert) => alert.id === 'id-49')).toBe(false);
  });

  it('counts the note as the API does: trimmed, by code point', () => {
    expect(noteLength('  abc  ')).toBe(3);
    expect(noteLength('😀😀')).toBe(2);
  });
});

describe('AlertsList', () => {
  const answer = (alerts: AlertSummary[], configured = true) =>
    call.mockImplementation((_method, path) => {
      if (path === 'security/admin/summary') return Promise.resolve(ok(summary()));
      if (path === 'security/admin/on-call') return Promise.resolve(ok({ configured }));
      return Promise.resolve(ok({ alerts, next: null }));
    });

  it('asks for live alerts first and links each row to its own page', async () => {
    answer([row()]);
    render(wrap(<AlertsList zone="UTC" />));
    const link = await screen.findByRole('link', { name: 'Many failed sign-ins for one account' });
    expect(link.getAttribute('href')).toBe(`/security/alerts/${ID}`);
    expect(call).toHaveBeenCalledWith(
      'GET',
      expect.stringMatching(/^security\/admin\/alerts\?.*state=open%2Cacknowledged/),
    );
  });

  it('says alerts are not sent when there is no roster', async () => {
    answer([row()], false);
    render(wrap(<AlertsList zone="UTC" />));
    expect(
      await screen.findByText('No on-call roster is set up. Alerts are not being sent.'),
    ).toBeTruthy();
    expect(screen.getAllByText('Not sent (no roster)').length).toBeGreaterThan(0);
  });

  it('shows a load error when the first read fails', async () => {
    call.mockImplementation((_method, path) =>
      Promise.resolve(path.startsWith('security/admin/alerts') ? fail(503) : ok(summary())),
    );
    render(wrap(<AlertsList zone="UTC" />));
    expect(await screen.findByText(/^Couldn't load alerts\./)).toBeTruthy();
  });
});

describe('AlertsList refresh', () => {
  const pages: (() => ApiResult<unknown>)[] = [];
  beforeEach(() => {
    pages.length = 0;
    call.mockImplementation((_method, path) => {
      if (path === 'security/admin/summary') return Promise.resolve(ok(summary()));
      if (path === 'security/admin/on-call') return Promise.resolve(ok({ configured: true }));
      return Promise.resolve((pages.shift() ?? (() => fail(503)))());
    });
  });

  it('keeps the last list and says the refresh failed', async () => {
    pages.push(
      () => ok({ alerts: [row()], next: null }),
      () => fail(503),
    );
    render(wrap(<AlertsList zone="UTC" />));
    await screen.findByRole('link', { name: 'Many failed sign-ins for one account' });
    poll();
    expect(await screen.findByText(/^Couldn't refresh\. Showing alerts as of/)).toBeTruthy();
    expect(screen.getByRole('link', { name: 'Many failed sign-ins for one account' })).toBeTruthy();
  });

  it('never says "no live alerts" when no page has loaded', async () => {
    pages.push(
      () => fail(503),
      () => fail(503),
    );
    render(wrap(<AlertsList zone="UTC" />));
    await screen.findByText(/^Couldn't load alerts\./);
    poll();
    await waitFor(() => expect(pages.length).toBe(0));
    expect(screen.getByText(/^Couldn't load alerts\./)).toBeTruthy();
    expect(screen.queryByText('No live alerts')).toBeNull();
  });

  it('starts from the filters in the address', async () => {
    pages.push(() => ok({ alerts: [], next: null }));
    render(wrap(<AlertsList zone="UTC" initialState="resolved" initialSeverities={['s1']} />));
    await waitFor(() =>
      expect(call).toHaveBeenCalledWith(
        'GET',
        'security/admin/alerts?limit=50&state=resolved&severity=s1',
      ),
    );
    expect(window.location.search).toBe('?state=resolved&severity=s1');
  });
});

describe('AlertDetailView', () => {
  const mount = (alert: AlertDetail, over: { canRespond?: boolean; roster?: boolean } = {}) =>
    render(
      wrap(
        <AlertDetailView
          initial={alert}
          zone="UTC"
          canRespond={over.canRespond ?? true}
          resolvers={over.roster === false ? null : { commander: 'Ali K.', owner: 'Hassan R.' }}
          csrfToken="csrf"
          maxSteps={12}
        />,
      ),
    );

  it('acknowledges with the version it shows and says the escalation stopped', async () => {
    mount(detail({ severity: 's1' }));
    call.mockResolvedValueOnce(
      ok(
        detail({
          severity: 's1',
          state: 'acknowledged',
          acknowledgedByName: 'Kazem M.',
          version: 4,
        }),
      ),
    );
    fireEvent.click(screen.getByRole('button', { name: 'Acknowledge' }));
    await expectToast('Acknowledged. Escalation stopped.');
    expect(call).toHaveBeenCalledWith(
      'POST',
      `security/admin/alerts/${ID}/acknowledge`,
      { expectedVersion: 3 },
      'csrf',
    );
  });

  it('names who acted first when acknowledge meets a conflict', async () => {
    mount(detail());
    call.mockResolvedValueOnce(fail(409, 'security.conflict')).mockResolvedValueOnce(
      ok(
        detail({
          state: 'acknowledged',
          acknowledgedAt: NOW,
          acknowledgedByName: 'Kazem M.',
          version: 4,
        }),
      ),
    );
    fireEvent.click(screen.getByRole('button', { name: 'Acknowledge' }));
    expect(await screen.findByText(/Kazem M\. acknowledged this alert/)).toBeTruthy();
  });

  it('keeps the note and offers to copy it when someone else resolved first', async () => {
    mount(detail({ state: 'acknowledged', acknowledgedByName: 'Kazem M.' }));
    fireEvent.click(screen.getByRole('button', { name: 'Resolve…' }));
    fireEvent.click(screen.getByLabelText(/False positive/));
    const note = screen.getByLabelText('What happened and what you did');
    fireEvent.change(note, { target: { value: 'Load test from the QA team.' } });
    call.mockResolvedValueOnce(fail(409, 'security.alert-state')).mockResolvedValueOnce(
      ok(
        detail({
          state: 'resolved',
          resolvedAt: NOW,
          resolvedByName: 'Hassan R.',
          resolution: 'duplicate',
          version: 5,
        }),
      ),
    );
    fireEvent.click(screen.getByRole('button', { name: 'Resolve alert' }));
    expect(await screen.findByRole('button', { name: 'Copy your note' })).toBeTruthy();
    expect((note as HTMLTextAreaElement).value).toBe('Load test from the QA team.');
    expect(screen.getAllByText(/Hassan R\. resolved this alert/).length).toBeGreaterThan(0);
  });

  it('keeps the dialog, outcome and note when someone acknowledged meanwhile', async () => {
    mount(detail());
    fireEvent.click(screen.getByRole('button', { name: 'Resolve…' }));
    fireEvent.click(screen.getByLabelText(/Contained/));
    const note = screen.getByLabelText('What happened and what you did');
    fireEvent.change(note, { target: { value: 'Blocked the IP at the edge.' } });
    call
      .mockResolvedValueOnce(fail(409, 'security.conflict'))
      .mockResolvedValueOnce(
        ok(detail({ state: 'acknowledged', acknowledgedByName: 'Kazem M.', version: 4 })),
      );
    fireEvent.click(screen.getByRole('button', { name: 'Resolve alert' }));
    expect(await screen.findByText(/Kazem M\. acknowledged this alert meanwhile/)).toBeTruthy();
    expect((note as HTMLTextAreaElement).value).toBe('Blocked the IP at the edge.');
    expect(screen.getByRole<HTMLButtonElement>('button', { name: 'Resolve alert' }).disabled).toBe(
      false,
    );
    call.mockResolvedValueOnce(
      ok(detail({ state: 'resolved', resolution: 'contained', resolvedByName: 'Ada', version: 5 })),
    );
    fireEvent.click(screen.getByRole('button', { name: 'Resolve alert' }));
    await expectToast('Alert resolved.');
    expect(call).toHaveBeenLastCalledWith(
      'POST',
      `security/admin/alerts/${ID}/resolve`,
      { expectedVersion: 4, resolution: 'contained', note: 'Blocked the IP at the edge.' },
      'csrf',
    );
  });

  it('says why a refused act was refused, by its code', async () => {
    mount(detail());
    call.mockResolvedValueOnce(fail(403, 'access.denied'));
    fireEvent.click(screen.getByRole('button', { name: 'Acknowledge' }));
    expect(await screen.findByText(/You can't act on this alert/)).toBeTruthy();
    expect(toastsOf('success')).toEqual([]);
  });

  it('says who acted when a refresh finds the alert changed', async () => {
    mount(detail());
    call.mockResolvedValueOnce(
      ok(detail({ state: 'acknowledged', acknowledgedAt: NOW, acknowledgedByName: 'Kazem M.' })),
    );
    poll();
    expect(await screen.findByText(/^Kazem M\. acknowledged this alert/)).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Acknowledge' })).toBeNull();
  });

  it('lets an S1 resolver resolve a critical alert', () => {
    mount(detail({ severity: 's1', viewerResolvesCritical: true }));
    expect(screen.getByRole<HTMLButtonElement>('button', { name: 'Resolve…' }).disabled).toBe(
      false,
    );
  });

  it('keeps the 15-minute clock and says nobody was told without a roster', () => {
    mount(detail({ severity: 's1' }), { roster: false });
    expect(screen.getByText('Respond within 15 minutes')).toBeTruthy();
    expect(
      screen.getByText(
        'Not sent: there is no on-call roster, so nobody has been told about this alert.',
      ),
    ).toBeTruthy();
  });

  it('tells a non-resolver who may resolve a critical alert', () => {
    mount(detail({ severity: 's1' }));
    expect(
      screen.getByText(/Only Ali K\. \(incident commander\) or Hassan R\. \(security owner\)/),
    ).toBeTruthy();
  });

  it('says a critical alert cannot be resolved without a roster', () => {
    mount(detail({ severity: 's1', viewerResolvesCritical: true }), { roster: false });
    expect(
      screen.getByText("Critical alerts can't be resolved until the on-call roster is set up."),
    ).toBeTruthy();
  });

  it('explains the missing permission instead of offering the acts', () => {
    mount(detail(), { canRespond: false });
    expect(
      screen.getByText('You need the Respond to security alerts permission to act on alerts.'),
    ).toBeTruthy();
  });
});

describe('CriticalAlertsBadge', () => {
  it('shows nothing without live critical alerts', async () => {
    call.mockResolvedValue(ok(summary(0)));
    const { container } = render(wrap(<CriticalAlertsBadge />));
    await waitFor(() => expect(call).toHaveBeenCalled());
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(container.querySelector('a')).toBeNull();
  });

  it('links to the alerts with a label that says what it opens', async () => {
    call.mockResolvedValue(ok(summary(2)));
    render(wrap(<CriticalAlertsBadge />));
    const link = await screen.findByRole('link', {
      name: '2 critical alerts. Open the security alerts',
    });
    expect(link.getAttribute('href')).toBe('/security/alerts');
  });
});
