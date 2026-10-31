// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { NextIntlClientProvider } from 'next-intl';
import type { ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import messages from '../../messages/en.json';

vi.mock('../api/client.ts', () => ({ callApi: vi.fn() }));

import { callApi } from '../api/client.ts';
import { humanField } from './last-changed.tsx';
import { SupportEmailCard } from './support-email-card.tsx';
import type { SupportContact } from './types.ts';

// "Last changed by … · … · View history" under the title, the history drawer, and the conflict
// banner that names who saved first (panel settings T3a, ST4). The support card stands for every
// admin settings page: they share the hook and the drawer.

const call = vi.mocked(callApi);
const wrap = (node: ReactNode) => (
  <NextIntlClientProvider locale="en-AU" messages={messages}>
    {node}
  </NextIntlClientProvider>
);
const ago = (ms: number) => new Date(Date.now() - ms).toISOString();
const contact = (over: Partial<SupportContact> = {}): SupportContact => ({
  email: 'help@example.com',
  version: 2,
  lastChanged: { at: ago(2 * 86_400_000), byDisplayName: 'Sara K.', byKind: 'member' },
  ...over,
});
const mount = (initial: SupportContact) =>
  render(wrap(<SupportEmailCard initial={initial} canManage csrfToken="csrf" />));

const row = (over: object = {}) => ({
  id: 'r1',
  at: ago(3_600_000),
  byDisplayName: 'Sara K.',
  byKind: 'member',
  fields: ['email'],
  ...over,
});

beforeEach(() => {
  vi.clearAllMocks();
  // jsdom has no modal <dialog>.
  HTMLDialogElement.prototype.showModal = function showModal(this: HTMLDialogElement) {
    this.setAttribute('open', '');
  };
  HTMLDialogElement.prototype.close = function close(this: HTMLDialogElement) {
    this.removeAttribute('open');
  };
});
afterEach(cleanup);

describe('the last-changed line', () => {
  it('names who and when under the title, with View history', () => {
    mount(contact());
    const line = screen.getByTestId('last-changed');
    expect(line.textContent).toBe('Last changed by Sara K. · 2 days ago · View history');
    expect(
      screen.getByRole('heading', { level: 1 }).compareDocumentPosition(line) &
        Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
  });

  it('says Mondapac for staff, and no name when none is known', () => {
    mount(
      contact({ lastChanged: { at: ago(86_400_000), byDisplayName: null, byKind: 'platform' } }),
    );
    expect(screen.getByTestId('last-changed').textContent).toBe(
      'Last changed by Mondapac · yesterday · View history',
    );
    cleanup();
    mount(
      contact({ lastChanged: { at: ago(3 * 3_600_000), byDisplayName: null, byKind: 'member' } }),
    );
    expect(screen.getByTestId('last-changed').textContent).toBe(
      'Last changed 3 hours ago · View history',
    );
  });

  it('shows no line while the page was never changed', () => {
    mount(contact({ lastChanged: null }));
    expect(screen.queryByTestId('last-changed')).toBeNull();
    cleanup();
    mount(contact({ lastChanged: undefined }));
    expect(screen.queryByTestId('last-changed')).toBeNull();
  });

  it('follows the save: the line names the answer of the PUT', async () => {
    call.mockResolvedValue({
      ok: true,
      status: 200,
      body: contact({
        email: 'care@example.com',
        version: 3,
        lastChanged: { at: ago(1000), byDisplayName: 'Amir R.', byKind: 'member' },
      }),
    });
    mount(contact());
    fireEvent.change(screen.getByLabelText('Support email address'), {
      target: { value: 'care@example.com' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Save changes' }));
    await waitFor(() =>
      expect(screen.getByTestId('last-changed').textContent).toContain('Amir R.'),
    );
  });
});

describe('the history drawer', () => {
  const open = () => fireEvent.click(screen.getByRole('button', { name: 'View history' }));

  it('loads the first page when opened and lists who, when and which fields', async () => {
    call.mockResolvedValue({
      ok: true,
      status: 200,
      body: {
        items: [
          row(),
          row({
            id: 'r2',
            byDisplayName: null,
            byKind: 'platform',
            fields: ['audiencePercent', 'enabled'],
          }),
        ],
        next: null,
      },
    });
    mount(contact());
    open();
    const dialog = await screen.findByRole('dialog', { name: 'History' });
    expect(call).toHaveBeenCalledWith(
      'GET',
      'notifications/admin/support-contact/history?limit=20',
    );
    expect(await within(dialog).findByText('Changed: Email')).toBeTruthy();
    expect(within(dialog).getByText('Sara K.')).toBeTruthy();
    expect(within(dialog).getByText('Mondapac')).toBeTruthy();
    expect(within(dialog).getByText('Changed: Audience percent, Enabled')).toBeTruthy();
    expect(within(dialog).queryByRole('button', { name: 'Show older changes' })).toBeNull();
  });

  it('shows a loading status first, then the empty state', async () => {
    let finish: (value: unknown) => void = () => undefined;
    call.mockReturnValue(new Promise((resolve) => (finish = resolve)) as never);
    mount(contact());
    open();
    const dialog = await screen.findByRole('dialog', { name: 'History' });
    expect(within(dialog).getByRole('status').textContent).toContain('Loading history');
    finish({ ok: true, status: 200, body: { items: [], next: null } });
    expect(await within(dialog).findByText('No changes yet')).toBeTruthy();
  });

  it('shows an error with Try again, which reads the first page again', async () => {
    call.mockResolvedValueOnce({ ok: false, failure: { status: 503, code: 'unavailable' } });
    mount(contact());
    open();
    const dialog = await screen.findByRole('dialog', { name: 'History' });
    expect(await within(dialog).findByText('The history could not be loaded.')).toBeTruthy();
    call.mockResolvedValueOnce({ ok: true, status: 200, body: { items: [row()], next: null } });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Try again' }));
    expect(await within(dialog).findByText('Changed: Email')).toBeTruthy();
    expect(call).toHaveBeenCalledTimes(2);
  });

  it('treats a malformed answer as an error, never a guess', async () => {
    call.mockResolvedValue({ ok: true, status: 200, body: { items: [{ id: 'x' }], next: null } });
    mount(contact());
    open();
    const dialog = await screen.findByRole('dialog', { name: 'History' });
    expect(await within(dialog).findByText('The history could not be loaded.')).toBeTruthy();
  });

  it('pages: Show older changes sends the cursor and appends; a failed page keeps the rows', async () => {
    call.mockResolvedValueOnce({
      ok: true,
      status: 200,
      body: { items: [row()], next: 'cursor-1' },
    });
    mount(contact());
    open();
    const dialog = await screen.findByRole('dialog', { name: 'History' });
    await within(dialog).findByText('Changed: Email');

    call.mockResolvedValueOnce({ ok: false, failure: { status: 0, code: 'network' } });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Show older changes' }));
    expect(await within(dialog).findByText('Older changes could not be loaded.')).toBeTruthy();
    expect(within(dialog).getByText('Changed: Email')).toBeTruthy();
    expect(call).toHaveBeenLastCalledWith(
      'GET',
      'notifications/admin/support-contact/history?limit=20&after=cursor-1',
    );

    call.mockResolvedValueOnce({
      ok: true,
      status: 200,
      body: { items: [row({ id: 'r9', fields: ['version'] })], next: null },
    });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Show older changes' }));
    await waitFor(() => expect(within(dialog).getAllByText(/^Changed:/)).toHaveLength(2));
    expect(within(dialog).queryByRole('button', { name: 'Show older changes' })).toBeNull();
  });

  it('closes with the close button and reads again when opened again', async () => {
    call.mockResolvedValue({ ok: true, status: 200, body: { items: [row()], next: null } });
    mount(contact());
    open();
    const dialog = await screen.findByRole('dialog', { name: 'History' });
    await within(dialog).findByText('Changed: Email');
    fireEvent.click(within(dialog).getByRole('button', { name: 'Close history' }));
    await waitFor(() => expect(screen.queryByRole('dialog', { name: 'History' })).toBeNull());
    open();
    await waitFor(() => expect(call).toHaveBeenCalledTimes(2));
  });
});

describe('the conflict banner', () => {
  const conflict = (winner: SupportContact['lastChanged']) => {
    call
      .mockResolvedValueOnce({
        ok: false,
        failure: { status: 409, code: 'notifications.conflict' },
      })
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        body: contact({ email: 'ops@example.com', version: 3, lastChanged: winner }),
      });
    mount(contact());
    fireEvent.change(screen.getByLabelText('Support email address'), {
      target: { value: 'care@example.com' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Save changes' }));
  };

  it('names who saved first and when', async () => {
    conflict({ at: ago(60_000), byDisplayName: 'Amir R.', byKind: 'member' });
    expect(await screen.findByText('Amir R. saved these settings 1 minute ago')).toBeTruthy();
    // The line under the title follows the re-read too.
    expect(screen.getByTestId('last-changed').textContent).toContain('Amir R.');
  });

  it('stays generic when the winner cannot be named', async () => {
    conflict({ at: ago(60_000), byDisplayName: null, byKind: 'member' });
    expect(await screen.findByText('Someone else saved these settings first')).toBeTruthy();
  });

  it('says Mondapac for staff', async () => {
    conflict({ at: ago(60_000), byDisplayName: null, byKind: 'platform' });
    expect(await screen.findByText('Mondapac saved these settings 1 minute ago')).toBeTruthy();
  });
});

describe('humanField', () => {
  it('words a field name from the API for a reader', () => {
    expect(humanField('audiencePercent')).toBe('Audience percent');
    expect(humanField('about')).toBe('About');
    expect(humanField('dailySpendCapUsdCents')).toBe('Daily spend cap usd cents');
  });
});
