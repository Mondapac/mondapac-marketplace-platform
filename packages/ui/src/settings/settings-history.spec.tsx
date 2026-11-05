import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { relativeTime, whoKind } from './change-time.ts';
import { SettingsHistoryDrawer, type SettingsHistoryDrawerProps } from './settings-history.tsx';
import { SettingsPage } from './settings-page.tsx';

const html = (node: React.ReactNode) => renderToStaticMarkup(node);

const labels: SettingsHistoryDrawerProps['labels'] = {
  title: 'History',
  close: 'Close history',
  loading: 'Loading history',
  emptyTitle: 'No changes yet',
  emptyBody: 'Changes show here.',
  error: 'History could not be loaded.',
  retry: 'Try again',
  loadMore: 'Show older',
  moreFailed: 'Older changes could not be loaded.',
};
const noop = () => undefined;
const drawer = (state: SettingsHistoryDrawerProps['state'], open = true) =>
  html(
    <SettingsHistoryDrawer
      open={open}
      onClose={noop}
      state={state}
      onLoadMore={noop}
      onRetry={noop}
      labels={labels}
    />,
  );

describe('relativeTime', () => {
  const now = new Date('2026-10-31T12:00:00Z');
  it.each([
    ['2026-10-31T11:59:40Z', 'now'],
    ['2026-10-31T11:59:00Z', '1 minute ago'],
    ['2026-10-31T09:00:00Z', '3 hours ago'],
    ['2026-10-29T12:00:00Z', '2 days ago'],
    ['2026-08-01T12:00:00Z', '3 months ago'],
    ['2026-10-31T12:03:00Z', 'in 3 minutes'],
  ])('reads %s as %s', (iso, text) => {
    expect(relativeTime(iso, 'en', now)).toBe(text);
  });

  it('reads a bad value as an empty text, and follows the locale', () => {
    expect(relativeTime('nope', 'en', now)).toBe('');
    expect(relativeTime('2026-10-29T12:00:00Z', 'de', now)).toBe('vorgestern');
  });
});

describe('whoKind', () => {
  it('names a person, Mondapac staff or nobody', () => {
    expect(whoKind({ byDisplayName: 'Sara K.', byKind: 'member' })).toBe('named');
    expect(whoKind({ byDisplayName: null, byKind: 'platform' })).toBe('platform');
    expect(whoKind({ byDisplayName: null, byKind: 'member' })).toBe('unnamed');
    expect(whoKind({ byDisplayName: '', byKind: 'system' })).toBe('unnamed');
  });
});

describe('SettingsPage last-changed line', () => {
  it('shows who and when under the title with a View history button that opens in place', () => {
    const out = html(
      <SettingsPage
        title="Support contact"
        lastChanged={{
          text: 'Last changed by Sara K. · 2 days ago',
          dateTime: '2026-10-29T12:00:00Z',
          historyLabel: 'View history',
          onHistory: () => undefined,
        }}
      >
        <p>body</p>
      </SettingsPage>,
    );
    expect(out).toContain('Last changed by Sara K. · 2 days ago');
    expect(out).toContain('<time dateTime="2026-10-29T12:00:00Z">');
    expect(out).toMatch(
      /<button[^>]*aria-haspopup="dialog"[^>]*aria-expanded="false"[^>]*>View history<\/button>/,
    );
    expect(out.indexOf('<h1')).toBeLessThan(out.indexOf('Last changed by'));
  });

  it('keeps the link form for a page with a history address', () => {
    const out = html(
      <SettingsPage
        title="X"
        lastChanged={{ text: 'Saved', historyHref: '/h', historyLabel: 'History' }}
      >
        <p>b</p>
      </SettingsPage>,
    );
    expect(out).toContain('<a href="/h"');
  });
});

describe('SettingsHistoryDrawer', () => {
  it('renders nothing inside while closed', () => {
    expect(drawer({ kind: 'loading' }, false)).not.toContain('History');
  });

  it('shows a polite loading status with placeholder rows', () => {
    const out = drawer({ kind: 'loading' });
    expect(out).toContain('role="status"');
    expect(out).toContain('Loading history');
    expect(out).toContain('animate-pulse');
  });

  it('shows the empty state', () => {
    const out = drawer({
      kind: 'ready',
      items: [],
      hasMore: false,
      loadingMore: false,
      moreFailed: false,
    });
    expect(out).toContain('No changes yet');
    expect(out).toContain('Changes show here.');
  });

  it('shows an alert with a retry on error', () => {
    const out = drawer({ kind: 'error' });
    expect(out).toContain('role="alert"');
    expect(out).toContain('History could not be loaded.');
    expect(out).toContain('Try again');
  });

  it('lists who, when and what, with a show-older button, and says when more failed', () => {
    const out = drawer({
      kind: 'ready',
      items: [
        {
          id: 'a',
          who: 'Sara K.',
          when: '2 days ago',
          dateTime: '2026-10-29T12:00:00Z',
          what: 'Changed: Reason, Status',
        },
      ],
      hasMore: true,
      loadingMore: false,
      moreFailed: true,
    });
    expect(out).toContain('Sara K.');
    expect(out).toContain('<time dateTime="2026-10-29T12:00:00Z"');
    expect(out).toContain('Changed: Reason, Status');
    expect(out).toContain('Show older');
    expect(out).toContain('Older changes could not be loaded.');
    expect(out).toContain('aria-label="Close history"');
  });
});
