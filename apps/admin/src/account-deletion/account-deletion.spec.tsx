// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { NextIntlClientProvider } from 'next-intl';
import type { ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import messages from '../../messages/en.json';

vi.mock('../api/client.ts', () => ({ callApi: vi.fn() }));

import { toast } from '@mondapac/ui';
import { callApi, type ApiResult } from '../api/client.ts';
import { CustomerLookup } from '../customers/customer-lookup.tsx';
import { settingsLink, settingsViewKeys, visibleSettings } from '../settings/settings-nav.ts';
import { StepUpProvider } from '../step-up/step-up.tsx';
import { BuyerDeletion } from './buyer-deletion.tsx';
import { blockersOf, deletionProblemOf } from './errors.ts';
import { AccountDeletionSettingsPanel } from './settings-panel.tsx';
import { RequestsList } from './requests-list.tsx';
import {
  reasonProblem,
  type AccountDeletionSettingsAnswer,
  type DeletionRequestEntry,
  type PendingCount,
} from './types.ts';

const call = vi.mocked(callApi);
const wrap = (node: ReactNode) => (
  <NextIntlClientProvider locale="en-AU" messages={messages}>
    <StepUpProvider>{node}</StepUpProvider>
  </NextIntlClientProvider>
);

const SETTINGS = 'customers/admin/account-deletion-settings';
const LIST = 'customers/admin/deletion-requests';
const ACCOUNT = '0190a000-0000-7000-8000-0000000000a1';
const REQUEST = '0190a000-0000-7000-8000-0000000000b1';
const ok = <T,>(body: T, status = 200): ApiResult<T> => ({ ok: true, status, body });
const refused = (status: number, code: string, details?: object): ApiResult<never> => ({
  ok: false,
  failure: { status, code, ...(details === undefined ? {} : { details }) },
});
const stepUpRequired = (actionKey: string) => refused(403, 'second-factor.required', { actionKey });
const answer = (enabled: boolean, waitingPeriodDays = 30, version = 3) => ({
  version,
  settings: { enabled, waitingPeriodDays },
});

beforeEach(() => {
  vi.resetAllMocks();
  HTMLDialogElement.prototype.showModal = function showModal(this: HTMLDialogElement) {
    this.setAttribute('open', '');
  };
  HTMLDialogElement.prototype.close = function close(this: HTMLDialogElement) {
    this.removeAttribute('open');
  };
});
afterEach(cleanup);

const dialogNamed = (name: string) => screen.getByRole('dialog', { name });
const typeReason = (dialog: HTMLElement, value = 'Owner approved') =>
  fireEvent.change(within(dialog).getByLabelText('Reason'), { target: { value } });

describe('reasonProblem', () => {
  it('takes 1 to 500 characters of one line without < or >', () => {
    expect(reasonProblem('ok')).toBe(false);
    expect(reasonProblem('x'.repeat(500))).toBe(false);
    for (const bad of ['', '   ', 'x'.repeat(501), 'a<b', 'a>b', 'two\nlines', 'tab\there'])
      expect(reasonProblem(bad)).toBe(true);
  });
});

describe('error mapping', () => {
  it('names the API codes and falls back by status', () => {
    expect(deletionProblemOf({ status: 409, code: 'customers.conflict' })).toBe('conflict');
    expect(deletionProblemOf({ status: 429, code: 'x' })).toBe('throttled');
    expect(deletionProblemOf({ status: 503, code: 'x' })).toBe('unavailable');
    expect(deletionProblemOf({ status: 0, code: 'network' })).toBe('unavailable');
    expect(deletionProblemOf({ status: 500, code: 'x' })).toBe('unknown');
  });

  it('reads typed blockers and ignores a malformed list', () => {
    const details = {
      blockers: [{ code: 'open-orders', count: 2 }, { code: 'wallet-balance' }, 7],
    };
    expect(blockersOf({ status: 409, code: 'c', details } as never)).toEqual([
      { code: 'open-orders', count: 2 },
      { code: 'wallet-balance' },
    ]);
    expect(blockersOf({ status: 409, code: 'c' })).toEqual([]);
  });
});

describe('settings map entry', () => {
  it('puts Account deletion in the Marketplace group, gated by its view and manage keys', () => {
    const found = settingsLink('account-deletion');
    expect(found?.group.id).toBe('marketplace');
    expect(found?.link).toMatchObject({
      href: '/settings/account-deletion',
      view: ['customers.account-deletion-settings.view'],
      manage: ['customers.account-deletion-settings.manage'],
    });
    expect(settingsViewKeys).toContain('customers.account-deletion-settings.view');
  });

  it('shows it for the view key, view only without manage, and not without the view key', () => {
    const links = (keys: string[]) =>
      visibleSettings(keys).flatMap(({ links: inGroup }) =>
        inGroup.map(({ link, viewOnly }) => [link.id, viewOnly] as const),
      );
    expect(links(['customers.account-deletion-settings.view'])).toEqual([
      ['account-deletion', true],
    ]);
    expect(
      links([
        'customers.account-deletion-settings.view',
        'customers.account-deletion-settings.manage',
      ]),
    ).toEqual([['account-deletion', false]]);
    expect(links(['customers.account-deletion-settings.manage'])).toEqual([]);
  });
});

describe('AccountDeletionSettingsPanel', () => {
  const none: PendingCount = { state: 'ok', count: 0, more: false };
  const mount = (
    initial: AccountDeletionSettingsAnswer = answer(false),
    pending: PendingCount = none,
    canManage = true,
  ) =>
    render(
      wrap(
        <AccountDeletionSettingsPanel
          initial={initial}
          canManage={canManage}
          pending={pending}
          csrfToken="csrf"
        />,
      ),
    );
  const save = () => screen.getByRole('button', { name: 'Save changes' });
  const enabledBox = () =>
    screen.getByRole<HTMLInputElement>('checkbox', {
      name: /Allow buyers to delete their account/,
    });
  const daysSelect = () =>
    screen.getByLabelText<HTMLSelectElement>(/Waiting period before deletion/);
  const choose = (on: boolean) => {
    if (enabledBox().checked !== on) fireEvent.click(enabledBox());
  };
  const success = () => vi.spyOn(toast, 'success').mockReturnValue('toast');

  it('shows the values in force, and the save bar only once something differs', () => {
    mount(answer(true, 14));
    expect(enabledBox().checked).toBe(true);
    expect(daysSelect().value).toBe('14');
    expect(screen.getByText('Saved version 3')).toBeTruthy();
    expect(screen.queryByText(/unsaved change/)).toBeNull();
    choose(false);
    expect(screen.getByText('1 unsaved change')).toBeTruthy();
    choose(true);
    expect(screen.queryByText(/unsaved change/)).toBeNull();
  });

  it('offers 7, 14, 30, 60 and 90 days, and the value in force when it is another', () => {
    mount(answer(false, 45));
    expect([...daysSelect().options].map((option) => option.value)).toEqual([
      '7',
      '14',
      '30',
      '45',
      '60',
      '90',
    ]);
  });

  it('is read-only without the manage permission: disabled fields, a note and no save bar', () => {
    mount(answer(true), none, false);
    expect(screen.getByText('You can view this setting but not change it.')).toBeTruthy();
    expect(enabledBox().disabled).toBe(true);
    expect(daysSelect().disabled).toBe(true);
    expect(screen.queryByRole('button', { name: 'Save changes' })).toBeNull();
  });

  it('turns it on: confirm, reason, then PUT with the version, and shows the saved toast', async () => {
    const toasted = success();
    call.mockResolvedValue(ok(answer(true, 30, 4)));
    mount(answer(false, 30, 3));
    choose(true);
    fireEvent.click(save());
    const dialog = dialogNamed('Turn on account deletion for all buyers?');
    expect(within(dialog).getByText(/after a 30-day wait/)).toBeTruthy();
    // Focus lands on the Reason field, not on a button.
    expect(document.activeElement).toBe(within(dialog).getByLabelText('Reason'));
    expect(call).not.toHaveBeenCalled();
    typeReason(dialog, '  Launch approved  ');
    fireEvent.click(within(dialog).getByRole('button', { name: 'Turn on' }));
    await waitFor(() => expect(call).toHaveBeenCalledTimes(1));
    expect(call).toHaveBeenCalledWith(
      'PUT',
      SETTINGS,
      {
        expectedVersion: 3,
        settings: { enabled: true, waitingPeriodDays: 30 },
        reason: 'Launch approved',
      },
      'csrf',
    );
    await waitFor(() =>
      expect(toasted).toHaveBeenCalledWith('Saved. Buyers see the change within a minute.'),
    );
    expect(screen.queryByText(/unsaved change/)).toBeNull();
    expect(screen.getByText('Saved version 4')).toBeTruthy();
    // The next change carries the new version, and starts with an empty reason.
    choose(false);
    fireEvent.click(save());
    const off = dialogNamed('Turn off account deletion?');
    expect(within(off).getByLabelText<HTMLTextAreaElement>('Reason').value).toBe('');
    typeReason(off);
    call.mockResolvedValue(ok(answer(false, 30, 5)));
    fireEvent.click(screen.getByRole('button', { name: 'Turn off' }));
    await waitFor(() => expect(call).toHaveBeenCalledTimes(2));
    expect(call.mock.calls[1]?.[2]).toMatchObject({ expectedVersion: 4 });
  });

  it('needs a valid reason: empty, too long or with < or > sends nothing', () => {
    mount();
    choose(true);
    fireEvent.click(save());
    const dialog = dialogNamed('Turn on account deletion for all buyers?');
    for (const bad of ['', '   ', 'x'.repeat(501), 'a <b> c']) {
      typeReason(dialog, bad);
      fireEvent.click(within(dialog).getByRole('button', { name: 'Turn on' }));
      expect(
        within(dialog).getByText('Enter a reason of 1 to 500 characters, without < or >.'),
      ).toBeTruthy();
    }
    expect(call).not.toHaveBeenCalled();
  });

  it('Enter in the Reason neither adds a line nor confirms', () => {
    mount();
    choose(true);
    fireEvent.click(save());
    const dialog = dialogNamed('Turn on account deletion for all buyers?');
    typeReason(dialog);
    const allowed = fireEvent.keyDown(within(dialog).getByLabelText('Reason'), { key: 'Enter' });
    expect(allowed).toBe(false);
    expect(call).not.toHaveBeenCalled();
  });

  it.each<[PendingCount, RegExp]>([
    [{ state: 'ok', count: 3, more: false }, /3 pending requests continue/],
    [{ state: 'ok', count: 100, more: true }, /100 or more pending requests continue/],
    [{ state: 'unavailable' }, /Pending requests continue/],
  ])('says how many requests continue when turning it off (%j)', (pending, text) => {
    mount(answer(true), pending);
    choose(false);
    fireEvent.click(save());
    expect(within(dialogNamed('Turn off account deletion?')).getByText(text)).toBeTruthy();
  });

  it('asks about the days alone with its own title and note', () => {
    mount(answer(true, 30));
    fireEvent.change(daysSelect(), { target: { value: '60' } });
    fireEvent.click(save());
    const dialog = dialogNamed('Change the waiting period to 60 days?');
    expect(within(dialog).getByText('Applies to new requests only.')).toBeTruthy();
    expect(within(dialog).getByRole('button', { name: 'Save' })).toBeTruthy();
  });

  it('cancelling the confirm sends nothing', () => {
    mount();
    choose(true);
    fireEvent.click(save());
    fireEvent.click(
      within(dialogNamed('Turn on account deletion for all buyers?')).getByRole('button', {
        name: 'Cancel',
      }),
    );
    expect(call).not.toHaveBeenCalled();
  });

  it('a cancelled code changes nothing: no message, the draft is kept', async () => {
    const toasted = success();
    call.mockImplementation((_method, path) =>
      Promise.resolve(
        path === SETTINGS ? stepUpRequired('customers.account-deletion-settings.change') : ok({}),
      ),
    );
    mount();
    choose(true);
    fireEvent.click(save());
    typeReason(dialogNamed('Turn on account deletion for all buyers?'));
    fireEvent.click(screen.getByRole('button', { name: 'Turn on' }));
    const code = await screen.findByRole('dialog', { name: 'Confirm it is you' });
    expect(within(code).getByText(/change the account deletion setting/)).toBeTruthy();
    // The reason dialog is closed before the code dialog opens.
    expect(
      screen.queryByRole('dialog', { name: 'Turn on account deletion for all buyers?' }),
    ).toBeNull();
    fireEvent.click(within(code).getByRole('button', { name: 'Cancel' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(screen.queryByRole('alert')).toBeNull();
    expect(toasted).not.toHaveBeenCalled();
    expect(enabledBox().checked).toBe(true);
    expect(screen.getByText('1 unsaved change')).toBeTruthy();
  });

  it('sends the code to the step-up route, then repeats the save', async () => {
    const toasted = success();
    let proven = false;
    call.mockImplementation((_method, path) => {
      if (path === 'identity/admin/step-up/verify') {
        proven = true;
        return Promise.resolve(ok({ code: 'step-up-verified' }));
      }
      return Promise.resolve(
        proven
          ? ok(answer(true, 30, 4))
          : stepUpRequired('customers.account-deletion-settings.change'),
      );
    });
    mount();
    choose(true);
    fireEvent.click(save());
    typeReason(dialogNamed('Turn on account deletion for all buyers?'));
    fireEvent.click(screen.getByRole('button', { name: 'Turn on' }));
    const code = await screen.findByRole('dialog', { name: 'Confirm it is you' });
    const first = within(code).getAllByRole('textbox', { name: /Digit \d of 6/ })[0] as HTMLElement;
    act(() => {
      fireEvent.paste(first, { clipboardData: { getData: () => '123456' } });
    });
    await waitFor(() => expect(toasted).toHaveBeenCalled());
  });

  it('sends an admin without a second factor to set one up (handled by the shared dialog)', async () => {
    call.mockResolvedValue(
      refused(403, 'second-factor.enrolment-required', {
        actionKey: 'customers.account-deletion-settings.change',
      }),
    );
    mount();
    choose(true);
    fireEvent.click(save());
    typeReason(dialogNamed('Turn on account deletion for all buyers?'));
    fireEvent.click(screen.getByRole('button', { name: 'Turn on' }));
    expect(await screen.findByRole('link', { name: 'Set up two-step' })).toBeTruthy();
  });

  it('keeps the draft on a stale version, compares it with what is saved, and the next save carries the new version', async () => {
    call.mockResolvedValueOnce(refused(409, 'customers.conflict'));
    call.mockResolvedValueOnce(ok(answer(false, 60, 4)));
    mount(answer(false, 30, 3));
    choose(true);
    fireEvent.click(save());
    typeReason(dialogNamed('Turn on account deletion for all buyers?'));
    fireEvent.click(screen.getByRole('button', { name: 'Turn on' }));
    await screen.findByRole('button', { name: 'Compare' });
    expect(call).toHaveBeenLastCalledWith('GET', SETTINGS);
    // The draft is kept (still On), the baseline is what the other admin saved.
    expect(enabledBox().checked).toBe(true);
    expect(daysSelect().value).toBe('30');
    expect(screen.getByText('Saved version 4')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Compare' }));
    expect(screen.getAllByText(/60 days/).length).toBeGreaterThan(0);
    call.mockResolvedValueOnce(ok(answer(true, 30, 5)));
    fireEvent.click(save());
    typeReason(dialogNamed('Turn on account deletion for all buyers?'));
    fireEvent.click(screen.getByRole('button', { name: 'Turn on' }));
    await waitFor(() => expect(call).toHaveBeenCalledTimes(3));
    expect(call.mock.calls[2]?.[2]).toMatchObject({ expectedVersion: 4 });
  });

  it('says so in words when the re-read after a conflict fails too', async () => {
    call.mockResolvedValueOnce(refused(409, 'customers.conflict'));
    call.mockResolvedValueOnce(refused(503, 'access.unavailable'));
    mount();
    choose(true);
    fireEvent.click(save());
    typeReason(dialogNamed('Turn on account deletion for all buyers?'));
    fireEvent.click(screen.getByRole('button', { name: 'Turn on' }));
    expect(
      await screen.findByText(
        'Another admin changed this setting. Reload the page to see the current value.',
      ),
    ).toBeTruthy();
    expect(enabledBox().checked).toBe(true);
  });

  it.each([
    [403, 'access.denied', "You don't have permission to change this."],
    [400, 'validation.failed', 'Enter a reason of 1 to 500 characters, without < or >.'],
    [
      503,
      'access.unavailable',
      'The service is not available right now. Try again in a few minutes.',
    ],
  ])('shows %s %s in words and keeps the choice', async (status, code, text) => {
    call.mockResolvedValue(refused(status, code));
    mount();
    choose(true);
    fireEvent.click(save());
    typeReason(dialogNamed('Turn on account deletion for all buyers?'));
    fireEvent.click(screen.getByRole('button', { name: 'Turn on' }));
    expect((await screen.findByRole('alert')).textContent).toContain(text);
    expect(enabledBox().checked).toBe(true);
  });

  it('counts the pending requests: none, some, one, 100+, unavailable, and hidden', () => {
    const view = (pending: PendingCount) => {
      cleanup();
      mount(answer(true), pending);
    };
    view({ state: 'ok', count: 0, more: false });
    expect(screen.getByText('No accounts are waiting to be deleted.')).toBeTruthy();
    expect(screen.getByRole('link', { name: 'View list' }).getAttribute('href')).toBe(
      '/settings/account-deletion/requests',
    );
    view({ state: 'ok', count: 1, more: false });
    expect(screen.getByText('1 account is waiting to be deleted.')).toBeTruthy();
    view({ state: 'ok', count: 12, more: false });
    expect(screen.getByText('12 accounts are waiting to be deleted.')).toBeTruthy();
    view({ state: 'ok', count: 100, more: true });
    expect(screen.getByText('100+ accounts are waiting to be deleted.')).toBeTruthy();
    view({ state: 'unavailable' });
    expect(
      screen.getByText("The number of waiting requests isn't available right now."),
    ).toBeTruthy();
    view({ state: 'hidden' });
    expect(screen.queryByText('Pending requests')).toBeNull();
    expect(screen.queryByRole('link', { name: 'View list' })).toBeNull();
  });
});

describe('RequestsList', () => {
  const entry = (n: number, over: Partial<DeletionRequestEntry> = {}): DeletionRequestEntry => ({
    requestId: `0190a000-0000-7000-8000-${String(n).padStart(12, '0')}`,
    accountId: `0190a000-0000-7000-8000-${String(n + 500).padStart(12, '0')}`,
    requestedAt: '2026-10-20T01:00:00.000Z',
    scheduledFor: '2026-11-19T01:00:00.000Z',
    status: 'pending',
    requestedBy: 'customer',
    ...over,
  });
  const page = (entries: DeletionRequestEntry[], nextCursor: string | null = null) =>
    ok({ entries, nextCursor });
  const mount = (canCancel = true) =>
    render(wrap(<RequestsList canCancel={canCancel} csrfToken="csrf" />));

  it('shows a loading state, then the rows with their columns', async () => {
    let release: (value: ApiResult<unknown>) => void = () => undefined;
    call.mockReturnValue(new Promise((resolve) => (release = resolve as never)));
    mount();
    expect(screen.getByRole('status').textContent).toContain('Loading the requests');
    release(page([entry(1), entry(2, { requestedBy: 'admin', status: 'executing' })]));
    expect(await screen.findByText('0190a000-0000-7000-8000-000000000501')).toBeTruthy();
    for (const header of [
      'Account',
      'Requested by',
      'Requested',
      'Deletes on',
      'Status',
      'Actions',
    ])
      expect(screen.getByRole('columnheader', { name: header })).toBeTruthy();
    expect(screen.getByText('Buyer')).toBeTruthy();
    expect(screen.getByText('Admin')).toBeTruthy();
    expect(screen.getByText('Waiting')).toBeTruthy();
    expect(screen.getByText('In progress')).toBeTruthy();
    expect(call).toHaveBeenCalledWith('GET', `${LIST}?limit=50`);
    // Cancel only for a waiting row.
    expect(screen.getAllByRole('button', { name: /^Cancel the deletion request/ })).toHaveLength(1);
  });

  it('shows the empty state', async () => {
    call.mockResolvedValue(page([]));
    mount();
    expect(await screen.findByText('No pending requests')).toBeTruthy();
    expect(screen.getByText('Accounts waiting to be deleted appear here.')).toBeTruthy();
  });

  it('shows a load error and retries', async () => {
    call.mockResolvedValueOnce(refused(503, 'access.unavailable'));
    mount();
    expect(await screen.findByText("Couldn't load the list.")).toBeTruthy();
    call.mockResolvedValueOnce(page([entry(1)]));
    fireEvent.click(screen.getByRole('button', { name: 'Try again' }));
    expect(await screen.findByText('0190a000-0000-7000-8000-000000000501')).toBeTruthy();
  });

  it('has no cancel button without customers.buyer-account.delete', async () => {
    call.mockResolvedValue(page([entry(1)]));
    mount(false);
    await screen.findByText('0190a000-0000-7000-8000-000000000501');
    expect(screen.queryByRole('columnheader', { name: 'Actions' })).toBeNull();
    expect(screen.queryByRole('button', { name: /Cancel/ })).toBeNull();
  });

  it('loads more with the cursor and announces it', async () => {
    call.mockResolvedValueOnce(
      page([entry(1)], '1792000000000.0190a000-0000-7000-8000-000000000001'),
    );
    mount();
    await screen.findByText('0190a000-0000-7000-8000-000000000501');
    call.mockResolvedValueOnce(page([entry(2), entry(3)]));
    fireEvent.click(screen.getByRole('button', { name: 'Load more' }));
    await screen.findByText('0190a000-0000-7000-8000-000000000503');
    expect(call).toHaveBeenLastCalledWith(
      'GET',
      `${LIST}?limit=50&cursor=1792000000000.0190a000-0000-7000-8000-000000000001`,
    );
    expect(screen.getByText('2 more requests loaded').closest('[role="status"]')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Load more' })).toBeNull();
  });

  it('keeps the rows and says so when loading more fails', async () => {
    call.mockResolvedValueOnce(page([entry(1)], '1.0190a000-0000-7000-8000-000000000001'));
    mount();
    await screen.findByText('0190a000-0000-7000-8000-000000000501');
    call.mockResolvedValueOnce(refused(503, 'access.unavailable'));
    fireEvent.click(screen.getByRole('button', { name: 'Load more' }));
    expect(await screen.findByText("Couldn't load more requests. Try again.")).toBeTruthy();
    expect(screen.getByText('0190a000-0000-7000-8000-000000000501')).toBeTruthy();
  });

  async function openCancel() {
    call.mockResolvedValueOnce(page([entry(1)]));
    mount();
    await screen.findByText('0190a000-0000-7000-8000-000000000501');
    fireEvent.click(screen.getByRole('button', { name: /^Cancel the deletion request/ }));
    const dialog = dialogNamed('Cancel this deletion request?');
    expect(within(dialog).getByText(/The buyer is not told/)).toBeTruthy();
    expect(within(dialog).getByText("Not saved. Don't enter personal data.")).toBeTruthy();
    expect(document.activeElement).toBe(within(dialog).getByLabelText('Reason'));
    return dialog;
  }

  it('cancels a waiting request with a reason and the code, and removes the row', async () => {
    const dialog = await openCancel();
    call.mockResolvedValueOnce(ok(null, 204));
    typeReason(dialog, 'Buyer asked by phone');
    fireEvent.click(within(dialog).getByRole('button', { name: 'Cancel request' }));
    await waitFor(() => expect(call).toHaveBeenCalledTimes(2));
    expect(call).toHaveBeenLastCalledWith(
      'DELETE',
      `${LIST}/0190a000-0000-7000-8000-000000000001`,
      { reason: 'Buyer asked by phone' },
      'csrf',
    );
    expect(
      await screen.findByText('Deletion request cancelled. The account is kept.'),
    ).toBeTruthy();
    expect(screen.queryByText('0190a000-0000-7000-8000-000000000501')).toBeNull();
  });

  it('keeps the request when the dialog is closed with "Keep request" or the reason is bad', async () => {
    const dialog = await openCancel();
    fireEvent.click(within(dialog).getByRole('button', { name: 'Cancel request' }));
    expect(within(dialog).getByText(/Enter a reason of 1 to 500/)).toBeTruthy();
    fireEvent.click(within(dialog).getByRole('button', { name: 'Keep request' }));
    expect(call).toHaveBeenCalledTimes(1);
    expect(screen.getByText('0190a000-0000-7000-8000-000000000501')).toBeTruthy();
  });

  it('starts each cancel dialog with an empty reason and no error', async () => {
    call.mockResolvedValueOnce(page([entry(1), entry(2)]));
    mount();
    await screen.findByText('0190a000-0000-7000-8000-000000000501');
    const buttons = () => screen.getAllByRole('button', { name: /^Cancel the deletion request/ });
    fireEvent.click(buttons()[0] as HTMLElement);
    let dialog = dialogNamed('Cancel this deletion request?');
    typeReason(dialog, 'first reason');
    fireEvent.click(within(dialog).getByRole('button', { name: 'Keep request' }));
    fireEvent.click(buttons()[1] as HTMLElement);
    dialog = dialogNamed('Cancel this deletion request?');
    expect(within(dialog).getByLabelText<HTMLTextAreaElement>('Reason').value).toBe('');
    // A failed call does not carry its reason or error into the next dialog either.
    typeReason(dialog, 'second reason');
    call.mockResolvedValueOnce(refused(503, 'access.unavailable'));
    fireEvent.click(within(dialog).getByRole('button', { name: 'Cancel request' }));
    await screen.findByRole('alert');
    fireEvent.click(buttons()[0] as HTMLElement);
    dialog = dialogNamed('Cancel this deletion request?');
    expect(within(dialog).getByLabelText<HTMLTextAreaElement>('Reason').value).toBe('');
    expect(within(dialog).queryByText(/Enter a reason of 1 to 500/)).toBeNull();
  });

  it('a cancelled code leaves the row and shows nothing', async () => {
    const dialog = await openCancel();
    call.mockResolvedValueOnce(stepUpRequired('customers.buyer-account.delete'));
    typeReason(dialog);
    fireEvent.click(within(dialog).getByRole('button', { name: 'Cancel request' }));
    const code = await screen.findByRole('dialog', { name: 'Confirm it is you' });
    fireEvent.click(within(code).getByRole('button', { name: 'Cancel' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(screen.queryByRole('alert')).toBeNull();
    expect(screen.getByText('0190a000-0000-7000-8000-000000000501')).toBeTruthy();
  });

  it('shows an in-progress request as in progress, without a button', async () => {
    const dialog = await openCancel();
    call.mockResolvedValueOnce(refused(409, 'customers.account-deletion-in-progress'));
    typeReason(dialog);
    fireEvent.click(within(dialog).getByRole('button', { name: 'Cancel request' }));
    expect(
      await screen.findByText("This account is already being deleted. It can't be cancelled."),
    ).toBeTruthy();
    expect(screen.getByText('In progress')).toBeTruthy();
    expect(screen.queryByRole('button', { name: /^Cancel the deletion request/ })).toBeNull();
  });

  it('drops a request that is no longer pending', async () => {
    const dialog = await openCancel();
    call.mockResolvedValueOnce(refused(404, 'customers.account-deletion-request-not-found'));
    typeReason(dialog);
    fireEvent.click(within(dialog).getByRole('button', { name: 'Cancel request' }));
    expect(await screen.findByText('This request is no longer pending.')).toBeTruthy();
    expect(screen.queryByText('0190a000-0000-7000-8000-000000000501')).toBeNull();
  });
});

describe('BuyerDeletion', () => {
  const mount = (waitingPeriodDays: number | null = 30) =>
    render(
      wrap(
        <BuyerDeletion
          accountId={ACCOUNT}
          waitingPeriodDays={waitingPeriodDays}
          csrfToken="csrf"
        />,
      ),
    );
  const open = () => {
    fireEvent.click(screen.getByRole('button', { name: "Delete this buyer's account" }));
    return dialogNamed("Delete this buyer's account?");
  };
  const fill = (dialog: HTMLElement, ticket = 'SUP-1042', reason = 'Buyer asked in ticket') => {
    fireEvent.change(within(dialog).getByLabelText('Support ticket'), {
      target: { value: ticket },
    });
    typeReason(dialog, reason);
    const box = within(dialog).getByRole<HTMLInputElement>('checkbox');
    if (!box.checked) fireEvent.click(box);
  };
  const confirm = (dialog: HTMLElement) =>
    fireEvent.click(within(dialog).getByRole('button', { name: 'Delete account' }));
  const made = {
    requestId: REQUEST,
    status: 'pending',
    requestedAt: '2026-10-29T01:00:00.000Z',
    scheduledFor: '2026-11-28T01:00:00.000Z',
    waitingPeriodDays: 30,
  };

  it('opens a dialog with the date line, focus on the ticket field and the button off until ticked', () => {
    mount();
    const dialog = open();
    expect(document.activeElement).toBe(within(dialog).getByLabelText('Support ticket'));
    expect(
      within(dialog).getByText(
        'The account will be deleted about 30 days after you confirm (the exact date is shown after).',
      ),
    ).toBeTruthy();
    expect(
      within(dialog).getByText("I understand this can't be undone after 30 days."),
    ).toBeTruthy();
    expect(
      within(dialog).getByRole<HTMLButtonElement>('button', { name: 'Delete account' }).disabled,
    ).toBe(true);
    expect(within(dialog).getByText("Link the buyer's request. Example: SUP-1042.")).toBeTruthy();
    expect(
      within(dialog).getByText("Don't enter personal data. It is deleted when the request closes."),
    ).toBeTruthy();
  });

  it('opens empty each time', () => {
    mount();
    let dialog = open();
    fill(dialog, 'SUP-1', 'some reason');
    fireEvent.click(within(dialog).getByRole('button', { name: 'Cancel' }));
    dialog = open();
    expect(within(dialog).getByLabelText<HTMLInputElement>('Support ticket').value).toBe('');
    expect(within(dialog).getByLabelText<HTMLTextAreaElement>('Reason').value).toBe('');
    expect(within(dialog).getByRole<HTMLInputElement>('checkbox').checked).toBe(false);
  });

  it('shows no number when the setting is not readable', () => {
    mount(null);
    const dialog = open();
    expect(within(dialog).getByText(/after the waiting period set in Settings/)).toBeTruthy();
    expect(
      within(dialog).getByText("I understand this can't be undone after the waiting period."),
    ).toBeTruthy();
  });

  it('checks the ticket and the reason before calling', () => {
    mount();
    const dialog = open();
    for (const bad of ['', '-x', 'has space', 'x'.repeat(65), '<b>']) {
      fill(dialog, bad);
      confirm(dialog);
      expect(within(dialog).getByText('Enter a ticket reference such as SUP-1042.')).toBeTruthy();
    }
    expect(call).not.toHaveBeenCalled();
  });

  it('requests the deletion, shows the date, a pending badge and a cancel button', async () => {
    call.mockResolvedValueOnce(ok(made, 201));
    mount();
    const dialog = open();
    fill(dialog, ' SUP-1042 ', ' Buyer asked in ticket ');
    confirm(dialog);
    await waitFor(() => expect(call).toHaveBeenCalledTimes(1));
    expect(call).toHaveBeenCalledWith(
      'POST',
      `customers/admin/buyers/${ACCOUNT}/deletion-requests`,
      { ticketRef: 'SUP-1042', reason: 'Buyer asked in ticket', confirm: true },
      'csrf',
    );
    const banner = await screen.findByText(/Deletion requested\. The account will be deleted on/);
    expect(banner.textContent).toContain('28 Nov 2026');
    expect(banner.textContent).toContain("The buyer's sessions have ended.");
    expect(document.activeElement).toBe(banner.closest('[tabindex="-1"]'));
    expect(screen.getByText('Deletion pending')).toBeTruthy();
    expect(screen.queryByRole('button', { name: "Delete this buyer's account" })).toBeNull();
    // Cancel it from here, with the id of the 201.
    call.mockResolvedValueOnce(ok(null, 204));
    fireEvent.click(screen.getByRole('button', { name: 'Cancel request' }));
    const cancel = dialogNamed('Cancel this deletion request?');
    typeReason(cancel);
    fireEvent.click(within(cancel).getByRole('button', { name: 'Cancel request' }));
    await waitFor(() =>
      expect(call).toHaveBeenLastCalledWith(
        'DELETE',
        `customers/admin/deletion-requests/${REQUEST}`,
        { reason: 'Owner approved' },
        'csrf',
      ),
    );
    expect(
      await screen.findByText('Deletion request cancelled. The account is kept.'),
    ).toBeTruthy();
    expect(screen.getByRole('button', { name: "Delete this buyer's account" })).toBeTruthy();
  });

  it('lists the blockers after the attempt and never mentions disputes', async () => {
    call.mockResolvedValueOnce(
      refused(409, 'customers.account-deletion-blocked', {
        blockers: [
          { code: 'open-orders', count: 2 },
          { code: 'pending-refunds', count: 1 },
          { code: 'wallet-balance' },
          { code: 'disputes', count: 4 },
        ],
      }),
    );
    mount();
    const dialog = open();
    fill(dialog);
    confirm(dialog);
    const banner = (await screen.findByText("Can't delete yet:")).closest(
      '[role="alert"]',
    ) as HTMLElement;
    expect(within(banner).getByText('2 open orders')).toBeTruthy();
    expect(within(banner).getByText('1 refund waiting')).toBeTruthy();
    expect(within(banner).getByText("The wallet balance isn't zero")).toBeTruthy();
    expect(banner.textContent).not.toMatch(/dispute/i);
    // Nothing was requested, so the delete button is still there.
    expect(screen.getByRole('button', { name: "Delete this buyer's account" })).toBeTruthy();
  });

  it('points to the pending list when a request is already open', async () => {
    call.mockResolvedValueOnce(refused(409, 'customers.account-deletion-already-requested'));
    mount();
    const dialog = open();
    fill(dialog);
    confirm(dialog);
    const banner = (
      await screen.findByText(/A deletion request is already open for this account/)
    ).closest('[role="alert"]') as HTMLElement;
    expect(within(banner).getByRole('link').getAttribute('href')).toBe(
      '/settings/account-deletion/requests',
    );
  });

  it.each([
    [404, 'customers.buyer-account-not-found', 'This buyer account was not found.'],
    [503, 'customers.unavailable', "Couldn't check this account. Try again."],
    [403, 'access.denied', "You don't have permission to change this."],
  ])('shows %s %s in words', async (status, code, text) => {
    call.mockResolvedValueOnce(refused(status, code));
    mount();
    const dialog = open();
    fill(dialog);
    confirm(dialog);
    expect((await screen.findByRole('alert')).textContent).toContain(text);
  });

  it('a cancelled code changes nothing and shows nothing', async () => {
    call.mockResolvedValueOnce(stepUpRequired('customers.buyer-account.delete'));
    mount();
    const dialog = open();
    fill(dialog);
    confirm(dialog);
    const code = await screen.findByRole('dialog', { name: 'Confirm it is you' });
    expect(within(code).getByText(/delete a buyer's account/)).toBeTruthy();
    fireEvent.click(within(code).getByRole('button', { name: 'Cancel' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(screen.queryByRole('alert')).toBeNull();
    expect(screen.getByRole('button', { name: "Delete this buyer's account" })).toBeTruthy();
  });
});

describe('CustomerLookup with the delete action', () => {
  const found = {
    accountId: ACCOUNT,
    email: 'sara@example.com',
    status: 'active',
    createdAt: '2026-10-01T02:30:00.000Z',
    emailVerified: true,
  };
  const find = async (buyerDeletion: { waitingPeriodDays: number | null } | null) => {
    call.mockResolvedValueOnce(ok(found));
    render(wrap(<CustomerLookup canChangeStatus buyerDeletion={buyerDeletion} csrfToken="csrf" />));
    fireEvent.change(screen.getByLabelText('Customer email'), {
      target: { value: 'sara@example.com' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Find customer' }));
    await screen.findByText('Customer account');
  };

  it('shows the action after the status action for an admin who may delete', async () => {
    await find({ waitingPeriodDays: 30 });
    const buttons = screen.getAllByRole('button').map((button) => button.textContent);
    expect(buttons.indexOf("Delete this buyer's account")).toBeGreaterThan(
      buttons.indexOf('Disable account'),
    );
  });

  it('hides the action without customers.buyer-account.delete', async () => {
    await find(null);
    expect(screen.queryByRole('button', { name: "Delete this buyer's account" })).toBeNull();
  });
});
