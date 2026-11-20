// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { NextIntlClientProvider } from 'next-intl';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import messages from '../../messages/en.json';

vi.mock('../api/client.ts', () => ({ callApi: vi.fn() }));

import { callApi } from '../api/client.ts';
import { FleetSelectionPanel } from './fleet-selection-panel.tsx';
import type { Selection } from './types.ts';
import { expectToast } from '../../test/toast-spy.ts';

const call = vi.mocked(callApi);
const MODEL = '01990000-0000-7000-8000-000000000001';
const review = { reviewed: true, risk: 'medium' };
const selection = (patch: Partial<Selection> = {}): Selection => ({
  version: 3,
  models: [{ id: MODEL, name: 'Cheapest first', rule: { kind: 'cheapest' }, version: 1 }],
  active: { instant: null, same_day: null, scheduled: null },
  defaultOrder: ['mondapac_drive'],
  fleets: [
    {
      fleet: 'mondapac_drive',
      displayName: 'Mondapac Drive',
      enabled: true,
      methods: ['instant', 'same_day'],
      reliability: 90,
      effectiveReliability: 90,
    },
  ],
  ...patch,
});
const mount = (initial: Selection) =>
  render(
    <NextIntlClientProvider locale="en-AU" messages={messages}>
      <FleetSelectionPanel initial={initial} canManage csrfToken="csrf" />
    </NextIntlClientProvider>,
  );
const ok = <T,>(body: T) => ({ ok: true as const, status: 200, body });
const noteRefused = {
  ok: false as const,
  failure: {
    status: 400,
    code: 'validation.failed',
    details: { fields: [{ path: 'note', code: 'required' }] },
  },
};
const confirmDialog = () =>
  fireEvent.click(screen.getByRole('button', { name: 'Confirm', hidden: true }));
const type = (text: string, index = 0) =>
  fireEvent.change(screen.getAllByLabelText('Note for reviewers')[index]!, {
    target: { value: text },
  });
const saveBar = () => fireEvent.click(screen.getByRole('button', { name: 'Save changes' }));
const pickInstant = () =>
  fireEvent.change(screen.getByLabelText('Instant'), { target: { value: MODEL } });

vi.setConfig({ testTimeout: 30_000 });

beforeEach(() => {
  vi.resetAllMocks();
  HTMLDialogElement.prototype.showModal = function () {
    this.setAttribute('open', '');
  };
  HTMLDialogElement.prototype.close = function () {
    this.removeAttribute('open');
  };
});
afterEach(cleanup);

describe('the fleet page where a change is reviewed', () => {
  it('asks for no note and sends none when not reviewed', async () => {
    call.mockResolvedValue(ok(selection({ version: 4 })));
    mount(selection({ review: { reviewed: false, risk: 'medium' } }));
    expect(screen.queryByLabelText('Note for reviewers')).toBeNull();
    pickInstant();
    saveBar();
    confirmDialog();
    await expectToast('Fleet settings saved. They apply to the next booking.');
    expect(call.mock.calls[0]?.[2]).not.toHaveProperty('note');
  });

  it('needs a note, sends it, says it was sent for review and drops request', async () => {
    mount(selection({ review }));
    pickInstant();
    saveBar();
    expect(await screen.findByText(/Write a note for the reviewers/)).toBeTruthy();
    expect(call).not.toHaveBeenCalled();
    type('Cheaper');
    call.mockResolvedValue(
      ok({ ...selection({ version: 4, review }), request: { id: 'r3', number: 5 } }),
    );
    saveBar();
    confirmDialog();
    await expectToast('Sent for review (SR-5)', 'info');
    expect(call.mock.calls[0]?.[2]).toMatchObject({ expectedVersion: 3, note: 'Cheaper' });
    expect(screen.getByLabelText<HTMLTextAreaElement>('Note for reviewers').value).toBe('');
  });

  it('shows a 400 on note on the page note field', async () => {
    call.mockResolvedValue(noteRefused);
    mount(selection({ review }));
    pickInstant();
    type('x');
    saveBar();
    confirmDialog();
    expect(await screen.findByText(/The note was refused/)).toBeTruthy();
  });
});

describe('the model editor where a change is reviewed', () => {
  it('asks a model edit for a note by the page flag, and sends it', async () => {
    mount(selection({ review }));
    fireEvent.click(screen.getByRole('button', { name: 'Actions for Cheapest first' }));
    fireEvent.click(screen.getByRole('menuitem', { name: 'Edit…' }));
    fireEvent.click(screen.getByRole('button', { name: 'Save model' }));
    expect(await screen.findAllByText(/Write a note for the reviewers/)).toHaveLength(1);
    expect(call).not.toHaveBeenCalled();
    type('Rename', 1);
    call
      .mockResolvedValueOnce(ok({ request: { id: 'r4', number: 6 } }))
      .mockResolvedValueOnce(ok(selection({ review })));
    fireEvent.click(screen.getByRole('button', { name: 'Save model' }));
    await expectToast('Sent for review (SR-6)', 'info');
    expect(call.mock.calls[0]?.[2]).toEqual({
      name: 'Cheapest first',
      rule: { kind: 'cheapest' },
      expectedVersion: 1,
      note: 'Rename',
    });
  });

  it('creates a model at once with no note where delivery is not reviewed', async () => {
    const off = { reviewed: false, risk: 'medium' };
    call
      .mockResolvedValueOnce({ ok: true as const, status: 201, body: { id: 'm2' } })
      .mockResolvedValueOnce(ok(selection({ review: off })));
    mount(selection({ review: off }));
    fireEvent.click(screen.getByRole('button', { name: 'New model' }));
    expect(screen.queryByLabelText('Note for reviewers')).toBeNull();
    expect(screen.queryByText(/Nothing changes until another admin approves it/)).toBeNull();
    fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'Fresh' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save model' }));
    await expectToast(/^Model created\./);
    expect(call.mock.calls[0]?.[2]).not.toHaveProperty('note');
  });

  it('sends a create for approval where delivery is reviewed: a note, then SR-n, the list unchanged', async () => {
    mount(selection({ review }));
    fireEvent.click(screen.getByRole('button', { name: 'New model' }));
    // The page's own note plus the form's, which says the create waits for approval.
    expect(screen.getAllByLabelText('Note for reviewers')).toHaveLength(2);
    expect(
      screen.getByText(
        'Nothing changes until another admin approves it in Admin Inbox > System requests.',
      ),
    ).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Save model' })).toBeNull();
    fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'Fresh' } });
    fireEvent.click(screen.getByRole('button', { name: 'Send for approval' }));
    expect(await screen.findAllByText(/Write a note for the reviewers/)).toHaveLength(1);
    expect(call).not.toHaveBeenCalled();

    type('A faster rule', 1);
    call.mockResolvedValueOnce({
      ok: true as const,
      status: 202,
      body: { request: { id: 'r9', number: 7 } },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Send for approval' }));
    await expectToast('Sent for approval (SR-7)', 'info');
    expect(call.mock.calls[0]).toEqual([
      'POST',
      'shipping/admin/fleet-selection/models',
      { name: 'Fresh', rule: { kind: 'cheapest' }, note: 'A faster rule' },
      'csrf',
    ]);
    // Nothing was created: the page is not read again and keeps its one model; no "created".
    expect(call).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole('button', { name: 'Send for approval' })).toBeNull();
    expect(screen.getAllByText('Cheapest first').length).toBeGreaterThan(0);
    expect(screen.queryByText('Fresh')).toBeNull();
  });

  it('names the proposal that already waits when the create is refused with 409', async () => {
    call.mockResolvedValueOnce({
      ok: false as const,
      failure: {
        status: 409,
        code: 'system-requests.already-pending',
        details: { pendingNumber: 7 },
      },
    });
    mount(selection({ review }));
    fireEvent.click(screen.getByRole('button', { name: 'New model' }));
    fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'Fresh' } });
    type('Again', 1);
    fireEvent.click(screen.getByRole('button', { name: 'Send for approval' }));
    expect(await screen.findByText('This is already waiting for approval (SR-7).')).toBeTruthy();
    // The form stays open with the admin's draft.
    expect(screen.getByRole('button', { name: 'Send for approval' })).toBeTruthy();
    expect(call).toHaveBeenCalledTimes(1);
  });

  it('falls back to the generic error when the 409 names no pending request', async () => {
    call.mockResolvedValueOnce({
      ok: false as const,
      failure: { status: 409, code: 'system-requests.already-pending' },
    });
    mount(selection({ review }));
    fireEvent.click(screen.getByRole('button', { name: 'New model' }));
    fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'Fresh' } });
    type('Again', 1);
    fireEvent.click(screen.getByRole('button', { name: 'Send for approval' }));
    expect(await screen.findByText('Something went wrong. Try again.')).toBeTruthy();
    expect(screen.queryByText(/already waiting for approval/)).toBeNull();
  });

  it('shows a 400 on note on the model form', async () => {
    call.mockResolvedValue(noteRefused);
    mount(selection({ review }));
    fireEvent.click(screen.getByRole('button', { name: 'Actions for Cheapest first' }));
    fireEvent.click(screen.getByRole('menuitem', { name: 'Edit…' }));
    type('x', 1);
    fireEvent.click(screen.getByRole('button', { name: 'Save model' }));
    expect(await screen.findByText(/The note was refused/)).toBeTruthy();
  });
});
