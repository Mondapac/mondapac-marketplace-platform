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
    fireEvent.click(screen.getByRole('button', { name: 'Edit Cheapest first' }));
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

  it('does not ask for a note when a model is created, and sends none', async () => {
    call.mockResolvedValueOnce(ok({})).mockResolvedValueOnce(ok(selection({ review })));
    mount(selection({ review }));
    fireEvent.click(screen.getByRole('button', { name: 'New model' }));
    expect(screen.getAllByLabelText('Note for reviewers')).toHaveLength(1);
    fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'Fresh' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save model' }));
    await expectToast(/^Model created\./);
    expect(call.mock.calls[0]?.[2]).not.toHaveProperty('note');
  });

  it('shows a 400 on note on the model form', async () => {
    call.mockResolvedValue(noteRefused);
    mount(selection({ review }));
    fireEvent.click(screen.getByRole('button', { name: 'Edit Cheapest first' }));
    type('x', 1);
    fireEvent.click(screen.getByRole('button', { name: 'Save model' }));
    expect(await screen.findByText(/The note was refused/)).toBeTruthy();
  });
});
