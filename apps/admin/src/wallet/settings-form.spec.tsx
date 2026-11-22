// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { NextIntlClientProvider } from 'next-intl';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import messages from '../../messages/en.json';

vi.mock('../api/client.ts', () => ({ callApi: vi.fn() }));

import { callApi } from '../api/client.ts';
import { STEP_UP_CANCELLED } from '../step-up/step-up.tsx';
import { SettingsForm } from './settings-form.tsx';
import type { WalletSettings } from './types.ts';
import { expectToast } from '../../test/toast-spy.ts';

const call = vi.mocked(callApi);
const settings = (over: Partial<WalletSettings> = {}): WalletSettings => ({
  status: 'off',
  reason: null,
  updatedAt: null,
  version: 0,
  ...over,
});
const ok = (body: unknown) => ({ ok: true as const, status: 200, body });
const refused = (status: number, code: string) => ({
  ok: false as const,
  failure: { status, code },
});

function mount(canManage = true) {
  render(
    <NextIntlClientProvider locale="en-AU" messages={messages}>
      <SettingsForm canManage={canManage} csrfToken="csrf" />
    </NextIntlClientProvider>,
  );
}
const choose = (state: string) =>
  fireEvent.change(screen.getByLabelText('New state'), { target: { value: state } });
const note = (text = 'Switching for launch') =>
  fireEvent.change(screen.getByLabelText('Note for reviewers'), { target: { value: text } });
const review = () => fireEvent.click(screen.getByRole('button', { name: 'Review change' }));
const confirmDialog = (name: string) => screen.findByRole('dialog', { name });

beforeEach(() => {
  vi.resetAllMocks();
  HTMLDialogElement.prototype.showModal = function showModal() {
    this.setAttribute('open', '');
  };
  HTMLDialogElement.prototype.close = function close() {
    this.removeAttribute('open');
  };
});
afterEach(cleanup);

describe('SettingsForm', () => {
  it('shows a loading state, then a never-changed Off wallet and the meaning of every state', async () => {
    call.mockResolvedValue(ok(settings()));
    mount();
    expect(screen.getByRole('status').textContent).toBe('Loading Customer wallet');
    expect(await screen.findByText('Never changed')).toBeTruthy();
    expect(call).toHaveBeenCalledWith('GET', 'wallet/admin/settings');
    expect(screen.getAllByText('Off').length).toBeGreaterThan(0);
    expect(screen.getByText(/Like paused, but for a security or legal problem/)).toBeTruthy();
  });

  it('shows the change time and reason of a paused wallet', async () => {
    call.mockResolvedValue(
      ok(
        settings({
          status: 'paused',
          reason: 'maintenance',
          updatedAt: '2026-10-01T02:30:00.000Z',
        }),
      ),
    );
    mount();
    expect(await screen.findByText('Changed 1 Oct 2026, 2:30 am UTC')).toBeTruthy();
    expect(screen.getByText('Reason: Maintenance')).toBeTruthy();
    expect(screen.getByText('Paused', { selector: 'span' })).toBeTruthy();
  });

  it('shows a load error with a retry that loads again', async () => {
    call.mockResolvedValueOnce(refused(503, 'access.unavailable'));
    call.mockResolvedValueOnce(ok(settings()));
    mount();
    expect(await screen.findByRole('alert')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Try again' }));
    expect(await screen.findByText('Never changed')).toBeTruthy();
  });

  it('gives up at 30 s with a retry, and drops the answer of the abandoned read', async () => {
    vi.useFakeTimers();
    try {
      let answerFirst: (value: ReturnType<typeof ok>) => void = () => undefined;
      call.mockImplementationOnce(() => new Promise((resolve) => (answerFirst = resolve)));
      call.mockResolvedValueOnce(ok(settings({ status: 'active' })));
      mount();
      act(() => {
        vi.advanceTimersByTime(200);
      });
      expect(document.querySelectorAll('[data-skeleton="section"]')).toHaveLength(3);
      expect(screen.queryByRole('region', { name: 'Unsaved changes' })).toBeNull();
      act(() => {
        vi.advanceTimersByTime(10_000);
      });
      expect(screen.getByText('Still loading…')).toBeTruthy();
      act(() => {
        vi.advanceTimersByTime(20_000);
      });
      expect(screen.getByText('This could not be loaded. Try again.')).toBeTruthy();
      await act(async () => {
        fireEvent.click(screen.getByRole('button', { name: 'Try again' }));
        await Promise.resolve();
      });
      await act(async () => {
        vi.advanceTimersByTime(400);
        await Promise.resolve();
      });
      expect(screen.getAllByText('Active').length).toBeGreaterThan(0);
      // The first read answers late: its "off" never replaces the newer answer.
      await act(async () => {
        answerFirst(ok(settings({ status: 'off' })));
        await Promise.resolve();
      });
      expect(screen.getAllByText('Active').length).toBeGreaterThan(0);
      expect(screen.queryByText('This could not be loaded. Try again.')).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  it('shows a view-only admin the danger zone disabled, with the reason and no button', async () => {
    call.mockResolvedValue(ok(settings()));
    mount(false);
    await screen.findByText('Never changed');
    expect(screen.getByText('View only')).toBeTruthy();
    expect(screen.getByText(/Your role can see these settings but not change them/)).toBeTruthy();
    expect(screen.getByLabelText<HTMLSelectElement>('New state').disabled).toBe(true);
    expect(screen.queryByRole('button', { name: 'Review change' })).toBeNull();
  });

  it('puts the change in a danger zone at the end, sent from the save bar', async () => {
    call.mockResolvedValue(ok(settings({ status: 'active', updatedAt: '2026-10-01T00:00:00Z' })));
    mount();
    await screen.findByText(/Changed/);
    const headings = screen.getAllByRole('heading', { level: 2 }).map((node) => node.textContent);
    expect(headings).toEqual(['Current state', 'What each state means', 'Danger zone']);
    const zone = screen.getByRole('heading', { name: 'Danger zone' }).closest('section')!;
    expect(zone.getAttribute('data-variant')).toBe('danger');
    expect(zone.contains(screen.getByLabelText('New state'))).toBe(true);
    expect(screen.queryByRole('button', { name: 'Review change' })).toBeNull();
    choose('paused');
    const bar = screen.getByRole('region', { name: 'Unsaved changes' });
    expect(within(bar).getByText('1 unsaved change')).toBeTruthy();
    expect(within(bar).getByRole('button', { name: 'Review change' })).toBeTruthy();
    expect(zone.contains(within(bar).getByRole('button', { name: 'Review change' }))).toBe(false);
  });

  it('shows the bar once the state differs, asks for a required reason, and discards', async () => {
    call.mockResolvedValue(
      ok(settings({ status: 'active', updatedAt: '2026-10-01T00:00:00.000Z' })),
    );
    mount();
    await screen.findByText('Changed 1 Oct 2026, 12:00 am UTC');
    expect(screen.queryByRole('region', { name: 'Unsaved changes' })).toBeNull();
    expect(screen.getByRole('option', { name: 'Active (current)' })).toBeTruthy();
    choose('paused');
    expect(screen.getByLabelText('Reason')).toBeTruthy();
    review();
    // No confirm without a reason: the field says what is missing and Review waits for it.
    expect(await screen.findByText('Choose a reason for this state.')).toBeTruthy();
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(document.activeElement).toBe(screen.getByLabelText('Reason'));
    const button = screen.getByRole<HTMLButtonElement>('button', { name: 'Review change' });
    expect(button.disabled).toBe(true);
    fireEvent.change(screen.getByLabelText('Reason'), { target: { value: 'maintenance' } });
    expect(button.disabled).toBe(false);
    choose('off');
    expect(screen.queryByLabelText('Reason')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Discard' }));
    expect(screen.queryByRole('region', { name: 'Unsaved changes' })).toBeNull();
    expect(screen.getByLabelText<HTMLSelectElement>('New state').value).toBe('active');
    expect(call.mock.calls.some(([method]) => method === 'PUT')).toBe(false);
  });

  it('only reviews on a form submit: an off switch opens its confirm and sends nothing', async () => {
    call.mockResolvedValue(
      ok(settings({ status: 'active', updatedAt: '2026-10-01T00:00:00.000Z' })),
    );
    mount();
    await screen.findByText(/Changed/);
    choose('off');
    note();
    // Enter in a field submits the page form; that is Review, never the change itself.
    fireEvent.submit(screen.getByLabelText('Note for reviewers').closest('form')!);
    expect(await confirmDialog('Turn the wallet off?')).toBeTruthy();
    expect(call.mock.calls.some(([method]) => method === 'PUT')).toBe(false);
  });

  it('confirms a pause with its reason, then sends it and shows the new state', async () => {
    call.mockResolvedValueOnce(
      ok(settings({ status: 'active', updatedAt: '2026-10-01T00:00:00.000Z' })),
    );
    mount();
    await screen.findByText(/Changed/);
    choose('paused');
    fireEvent.change(screen.getByLabelText('Reason'), { target: { value: 'maintenance' } });
    review();
    const dialog = await confirmDialog('Pause the wallet?');
    expect(dialog.textContent).toContain('Reason: Maintenance');
    call.mockResolvedValueOnce(
      ok(
        settings({
          status: 'paused',
          reason: 'maintenance',
          updatedAt: '2026-10-27T01:00:00.000Z',
        }),
      ),
    );
    fireEvent.click(screen.getByRole('button', { name: 'Pause wallet' }));
    await expectToast('Wallet is now paused.');
    expect(call).toHaveBeenLastCalledWith(
      'PUT',
      'wallet/admin/settings',
      { status: 'paused', reasonCode: 'maintenance', expectedVersion: 0 },
      'csrf',
    );
    expect(screen.getByText('Reason: Maintenance')).toBeTruthy();
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('asks for a note on a money change, counts it, and sends it', async () => {
    call.mockResolvedValueOnce(ok(settings({ status: 'paused', reason: 'maintenance' })));
    mount();
    await screen.findByText('Never changed');
    choose('active');
    review();
    expect(screen.getByText(/Write a note for the reviewers/)).toBeTruthy();
    expect(document.activeElement).toBe(screen.getByLabelText('Note for reviewers'));
    expect(call).toHaveBeenCalledTimes(1);
    note('Open it');
    expect(screen.getByText('7 / 500')).toBeTruthy();
    call.mockResolvedValueOnce(
      ok({ ...settings({ status: 'active' }), request: { id: 'r1', number: 12 } }),
    );
    review();
    await expectToast('Sent for review (SR-12)', 'info');
    expect(call).toHaveBeenLastCalledWith(
      'PUT',
      'wallet/admin/settings',
      { status: 'active', expectedVersion: 0, note: 'Open it' },
      'csrf',
    );
  });

  it('shows no note field for a switch to paused or frozen, and sends none', async () => {
    call.mockResolvedValueOnce(
      ok(settings({ status: 'active', updatedAt: '2026-10-01T00:00:00.000Z' })),
    );
    mount();
    await screen.findByText(/Changed/);
    expect(screen.getByLabelText('Note for reviewers')).toBeTruthy();
    choose('frozen');
    expect(screen.queryByLabelText('Note for reviewers')).toBeNull();
    choose('paused');
    expect(screen.queryByLabelText('Note for reviewers')).toBeNull();
    fireEvent.change(screen.getByLabelText('Reason'), { target: { value: 'maintenance' } });
    review();
    await confirmDialog('Pause the wallet?');
    call.mockResolvedValueOnce(ok(settings({ status: 'paused', reason: 'maintenance' })));
    fireEvent.click(screen.getByRole('button', { name: 'Pause wallet' }));
    await expectToast('Wallet is now paused.');
    const body = call.mock.calls.at(-1)?.[2] as Record<string, unknown>;
    expect('note' in body).toBe(false);
  });

  it('shows a 400 on note as an error on the note field', async () => {
    call.mockResolvedValueOnce(
      ok(settings({ status: 'paused', reason: 'maintenance', updatedAt: '2026-10-01T00:00:00Z' })),
    );
    mount();
    await screen.findByText(/Changed/);
    choose('active');
    note();
    call.mockResolvedValueOnce({
      ok: false as const,
      failure: {
        status: 400,
        code: 'validation.failed',
        details: { fields: [{ path: 'note', code: 'required' }] },
      },
    });
    review();
    expect(await screen.findByText(/The note was refused/)).toBeTruthy();
    expect(screen.queryByText('Choose a reason for this state.')).toBeNull();
    // A refusal from the server does not lock Review: the same note can be sent again.
    expect(screen.getByRole<HTMLButtonElement>('button', { name: 'Review change' }).disabled).toBe(
      false,
    );
  });

  it('has a confirm for frozen and off with their own words', async () => {
    call.mockResolvedValueOnce(
      ok(settings({ status: 'active', updatedAt: '2026-10-01T00:00:00.000Z' })),
    );
    mount();
    await screen.findByText(/Changed/);
    choose('frozen');
    fireEvent.change(screen.getByLabelText('Reason'), { target: { value: 'legal-hold' } });
    review();
    expect(await confirmDialog('Freeze the wallet?')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    choose('off');
    note();
    review();
    const off = await confirmDialog('Turn the wallet off?');
    expect(off.textContent).toContain('use Paused instead');
  });

  it('applies Active without a confirm dialog', async () => {
    call.mockResolvedValueOnce(
      ok(
        settings({
          status: 'paused',
          reason: 'maintenance',
          updatedAt: '2026-10-01T00:00:00.000Z',
        }),
      ),
    );
    mount();
    await screen.findByText(/Changed/);
    choose('active');
    note();
    call.mockResolvedValueOnce(
      ok(settings({ status: 'active', updatedAt: '2026-10-27T01:00:00.000Z' })),
    );
    review();
    await expectToast('Wallet is now active.');
    expect(call).toHaveBeenLastCalledWith(
      'PUT',
      'wallet/admin/settings',
      { status: 'active', expectedVersion: 0, note: 'Switching for launch' },
      'csrf',
    );
  });

  it.each([
    ['wallet.cannot-turn-off-with-history', 409, /Choose Paused instead/],
    ['wallet.busy', 409, /Another change is in progress/],
    ['access.denied', 403, /permission to change the wallet/],
    ['access.unavailable', 503, /We could not save the change/],
    ['something.else', 500, /Something went wrong/],
  ])('says what %s means', async (code, status, text) => {
    call.mockResolvedValueOnce(
      ok(settings({ status: 'active', updatedAt: '2026-10-01T00:00:00.000Z' })),
    );
    mount();
    await screen.findByText(/Changed/);
    choose('off');
    note();
    review();
    await confirmDialog('Turn the wallet off?');
    call.mockResolvedValueOnce(refused(status, code));
    fireEvent.click(screen.getByRole('button', { name: 'Turn off' }));
    expect((await screen.findByRole('alert')).textContent).toMatch(text);
    // The state shown stays the one the server last told us.
    expect(screen.getByText('Changed 1 Oct 2026, 12:00 am UTC')).toBeTruthy();
  });

  it('sends the version it loaded, and on a conflict shows the banner, the current state and keeps the chosen one', async () => {
    call.mockResolvedValueOnce(
      ok(settings({ status: 'active', updatedAt: '2026-10-01T00:00:00.000Z', version: 3 })),
    );
    mount();
    await screen.findByText(/Changed/);
    choose('paused');
    fireEvent.change(screen.getByLabelText('Reason'), { target: { value: 'maintenance' } });
    review();
    await confirmDialog('Pause the wallet?');
    call.mockResolvedValueOnce(refused(409, 'wallet.settings-conflict'));
    // The reload after the conflict: another admin froze the wallet meanwhile.
    call.mockResolvedValueOnce(
      ok(
        settings({
          status: 'frozen',
          reason: 'legal-hold',
          updatedAt: '2026-10-02T00:00:00.000Z',
          version: 4,
        }),
      ),
    );
    fireEvent.click(screen.getByRole('button', { name: 'Pause wallet' }));
    expect(
      await screen.findByText('The wallet state changed while you were on this page'),
    ).toBeTruthy();
    expect(call).toHaveBeenNthCalledWith(
      2,
      'PUT',
      'wallet/admin/settings',
      { status: 'paused', reasonCode: 'maintenance', expectedVersion: 3 },
      'csrf',
    );
    expect(await screen.findByText('Reason: Legal hold')).toBeTruthy();
    expect(screen.getByLabelText<HTMLSelectElement>('New state').value).toBe('paused');
    expect(screen.getByLabelText<HTMLSelectElement>('Reason').value).toBe('maintenance');
    // The next save carries the new version and clears the banner.
    review();
    await confirmDialog('Pause the wallet?');
    call.mockResolvedValueOnce(
      ok(
        settings({
          status: 'paused',
          reason: 'maintenance',
          updatedAt: '2026-10-03T00:00:00.000Z',
          version: 5,
        }),
      ),
    );
    fireEvent.click(screen.getByRole('button', { name: 'Pause wallet' }));
    await expectToast('Wallet is now paused.');
    expect(call).toHaveBeenLastCalledWith(
      'PUT',
      'wallet/admin/settings',
      { status: 'paused', reasonCode: 'maintenance', expectedVersion: 4 },
      'csrf',
    );
    expect(screen.queryByText('The wallet state changed while you were on this page')).toBeNull();
  });

  it('puts a validation answer on the reason field', async () => {
    call.mockResolvedValueOnce(
      ok(settings({ status: 'active', updatedAt: '2026-10-01T00:00:00.000Z' })),
    );
    mount();
    await screen.findByText(/Changed/);
    choose('paused');
    fireEvent.change(screen.getByLabelText('Reason'), { target: { value: 'maintenance' } });
    review();
    await confirmDialog('Pause the wallet?');
    call.mockResolvedValueOnce(refused(400, 'validation.failed'));
    fireEvent.click(screen.getByRole('button', { name: 'Pause wallet' }));
    expect(await screen.findByText('Choose a reason for this state.')).toBeTruthy();
  });

  it('says nothing when the code dialog was cancelled', async () => {
    call.mockResolvedValueOnce(
      ok(settings({ status: 'active', updatedAt: '2026-10-01T00:00:00.000Z' })),
    );
    mount();
    await screen.findByText(/Changed/);
    choose('off');
    note();
    review();
    await confirmDialog('Turn the wallet off?');
    call.mockResolvedValueOnce({ ok: false, failure: { status: 0, code: STEP_UP_CANCELLED } });
    fireEvent.click(screen.getByRole('button', { name: 'Turn off' }));
    await waitFor(() => expect(call).toHaveBeenCalledTimes(2));
    expect(screen.queryByRole('alert')).toBeNull();
    expect(screen.queryByText(/Wallet is now/)).toBeNull();
  });
});

describe('SettingsForm: unusual data from the server', () => {
  it('treats a wallet state it does not know as a load error', async () => {
    call.mockResolvedValue(ok({ status: 'short', reason: null, updatedAt: null, version: 0 }));
    mount();
    expect(await screen.findByRole('alert')).toBeTruthy();
  });

  it('shows a reason with dots as plain text', async () => {
    call.mockResolvedValue(
      ok(settings({ status: 'paused', reason: 'a.b', updatedAt: '2026-10-01T00:00:00.000Z' })),
    );
    mount();
    expect(await screen.findByText('Reason: a.b')).toBeTruthy();
  });

  it('shows who changed the switch last under the title, and names the winner in the conflict', async () => {
    const at = new Date(Date.now() - 2 * 86_400_000).toISOString();
    call.mockResolvedValue(
      ok(
        settings({
          status: 'paused',
          reason: 'maintenance',
          version: 3,
          lastChanged: { at, byDisplayName: 'Sara K.', byKind: 'member' },
        }),
      ),
    );
    mount();
    expect((await screen.findByTestId('last-changed')).textContent).toBe(
      'Last changed by Sara K. · 2 days ago · View history',
    );
    // The history opens on this page's own route.
    call.mockResolvedValueOnce(ok({ items: [], next: null }));
    fireEvent.click(screen.getByRole('button', { name: 'View history' }));
    await waitFor(() =>
      expect(call).toHaveBeenCalledWith('GET', 'wallet/admin/settings/history?limit=20'),
    );
    expect(await screen.findByText('No changes yet')).toBeTruthy();
  });

  it('names who saved first in the conflict banner when the re-read says so', async () => {
    call.mockResolvedValueOnce(
      ok(settings({ status: 'active', updatedAt: '2026-10-01T00:00:00.000Z', version: 3 })),
    );
    mount();
    await screen.findByText(/Changed/);
    choose('paused');
    fireEvent.change(screen.getByLabelText('Reason'), { target: { value: 'maintenance' } });
    review();
    await confirmDialog('Pause the wallet?');
    call.mockResolvedValueOnce(refused(409, 'wallet.settings-conflict'));
    call.mockResolvedValueOnce(
      ok(
        settings({
          status: 'frozen',
          reason: 'legal-hold',
          updatedAt: '2026-10-02T00:00:00.000Z',
          version: 4,
          lastChanged: {
            at: new Date(Date.now() - 60_000).toISOString(),
            byDisplayName: 'Amir R.',
            byKind: 'member',
          },
        }),
      ),
    );
    fireEvent.click(screen.getByRole('button', { name: 'Pause wallet' }));

    expect(await screen.findByText('Amir R. saved these settings 1 minute ago')).toBeTruthy();
  });
});
