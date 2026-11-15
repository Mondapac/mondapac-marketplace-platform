import { NextIntlClientProvider } from 'next-intl';
import { createRoot } from 'react-dom/client';
import messages from '../../messages/en.json';
import '../../app/globals.css';
import { AlertDetailView } from '../../src/security-centre/alert-detail.tsx';
import { AlertsList } from '../../src/security-centre/alerts-list.tsx';
import { CriticalAlertsBadge } from '../../src/security-centre/critical-badge.tsx';
import { OnCallView } from '../../src/security-centre/on-call-view.tsx';
import type { AlertDetail, AlertSummary, OnCall } from '../../src/security-centre/types.ts';

const view = new URLSearchParams(location.search).get('view') ?? 'list';
const id = (n: number) => `0190a000-0000-7000-8000-${String(n).padStart(12, '0')}`;
const ago = (minutes: number) => new Date(Date.now() - minutes * 60_000).toISOString();
const row = (n: number, over: Partial<AlertSummary>): AlertSummary => ({
  id: id(n),
  rule: 'auth.brute-force',
  title: 'Many failed sign-ins for one account',
  severity: 's2',
  state: 'open',
  keyType: 'account',
  keyLabel: 'acc-7f3a…91c2',
  eventCount: 14,
  firstEventAt: ago(40),
  lastEventAt: ago(3),
  openedAt: ago(30),
  acknowledgedAt: null,
  acknowledgedByName: null,
  resolvedAt: null,
  nextNotifyAt: null,
  version: 2,
  ...over,
});
const alerts = [
  row(1, {
    severity: 's1',
    title: 'Admin signed in from a new country',
    rule: 'auth.admin-new-country',
    keyType: 'ip',
    keyLabel: '203.0.113.x',
    eventCount: 1,
    openedAt: ago(8),
  }),
  row(2, {
    severity: 's1',
    title: 'Payout account changed twice in an hour',
    rule: 'payouts.bank-change-burst',
    state: 'acknowledged',
    acknowledgedAt: ago(10),
    acknowledgedByName: 'Kazem M.',
    openedAt: ago(22),
  }),
  row(3, {}),
  row(4, {
    severity: 's3',
    title: 'Password reset requests from one IP',
    rule: 'auth.reset-burst',
    keyType: 'ip',
    keyLabel: '198.51.100.x',
    eventCount: 31,
    openedAt: ago(200),
  }),
];
const roster: OnCall = {
  configured: true,
  zone: 'Australia/Brisbane',
  businessHours: { start: '08:00', end: '18:00', days: [1, 2, 3, 4, 5] },
  inBusinessHours: true,
  onCall: { code: 'hassan', name: 'Hassan R.' },
  escalation: [
    { code: 'hassan', name: 'Hassan R.' },
    { code: 'kazem', name: 'Kazem M.' },
    { code: 'ali', name: 'Ali K.' },
  ],
  escalationIntervalMinutes: 5,
  escalationMaxSteps: 12,
  rotation: [0, 1, 2, 3].map((week) => ({
    startsAt: new Date(Date.now() + (week * 7 - 2) * 86_400_000).toISOString(),
    ...[
      { code: 'hassan', name: 'Hassan R.' },
      { code: 'kazem', name: 'Kazem M.' },
      { code: 'ali', name: 'Ali K.' },
      { code: 'hassan', name: 'Hassan R.' },
    ][week]!,
  })),
  incidentCommander: { code: 'ali', name: 'Ali K.' },
  securityOwner: { code: 'hassan', name: 'Hassan R.' },
  channels: {
    s1: ['email', 'sms', 'call'],
    s2: ['email', 'team-chat'],
    s3: ['email'],
    s4: ['email'],
  },
};
const detail: AlertDetail = {
  ...alerts[0]!,
  keyValue: '203.0.113.42',
  notifyStep: 2,
  nextNotifyAt: new Date(Date.now() + 2 * 60_000).toISOString(),
  acknowledgedBy: null,
  resolvedBy: null,
  resolvedByName: null,
  viewerResolvesCritical: view === 'resolve',
  resolution: null,
  resolutionNote: null,
  deliveries: [
    { step: 1, recipient: 'Hassan R.', channel: 'email', outcome: 'sent', at: ago(8) },
    { step: 1, recipient: 'Hassan R.', channel: 'sms', outcome: 'not-configured', at: ago(8) },
    { step: 2, recipient: 'Kazem M.', channel: 'email', outcome: 'sent', at: ago(3) },
  ],
};
window.fetch = ((input: string) => {
  const path = input.replace(/^\/api\//, '').split('?')[0]!;
  const body =
    path === 'security/admin/summary'
      ? {
          live: { s1: 2, s2: 1, s3: 1, s4: 0 },
          rulesLastRanAt: ago(1),
          onCall: { code: 'hassan', name: 'Hassan R.' },
        }
      : path === 'security/admin/on-call'
        ? roster
        : path === 'security/admin/alerts'
          ? { alerts, next: id(4) }
          : detail;
  return Promise.resolve(new Response(JSON.stringify(body), { status: 200 }));
}) as typeof fetch;

const frame = async () => {
  if (view === 'oncall') {
    return await OnCallView({ onCall: roster, locale: 'en-AU', now: new Date().toISOString() });
  }
  if (view === 'list') return <AlertsList zone="Australia/Brisbane" />;
  return (
    <AlertDetailView
      initial={detail}
      zone="Australia/Brisbane"
      canRespond
      resolvers={{ commander: 'Ali K.', owner: 'Hassan R.' }}
      csrfToken="tok"
      maxSteps={12}
    />
  );
};

void frame().then((body) =>
  createRoot(document.getElementById('root')!).render(
    <NextIntlClientProvider locale="en-AU" messages={messages} timeZone="Australia/Brisbane">
      <header className="flex items-center justify-end gap-2 border-b border-line bg-surface p-3">
        <CriticalAlertsBadge />
      </header>
      <main className="mx-auto max-w-7xl p-4 md:p-6">
        {view === 'list' || view === 'oncall' ? (
          <h1 className="mb-4 text-2xl font-semibold">{messages['security-centre'].title}</h1>
        ) : null}
        {body}
      </main>
    </NextIntlClientProvider>,
  ),
);
