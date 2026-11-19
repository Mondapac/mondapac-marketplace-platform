// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { NextIntlClientProvider } from 'next-intl';
import type { ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import messages from '../../messages/en.json';

vi.mock('../api/client.ts', () => ({ callApi: vi.fn() }));

import { callApi } from '../api/client.ts';
import { DeliverySettingsPanel } from './delivery-settings-panel.tsx';
import { SellerMethodsCard } from './seller-methods-card.tsx';
import type { DeliverySettings, SellerMethods } from './types.ts';
import { expectToast } from '../../test/toast-spy.ts';

const call = vi.mocked(callApi);
const wrap = (node: ReactNode) => (
  <NextIntlClientProvider locale="en-AU" messages={messages}>
    {node}
  </NextIntlClientProvider>
);

const review = { reviewed: true, risk: 'medium' };
const notReviewed = { reviewed: false, risk: 'medium' };
const settings = (patch: Partial<DeliverySettings> = {}): DeliverySettings => ({
  enabled: { pickup: true, instant: true, same_day: true, scheduled: true },
  sameDayCutoff: '12:00',
  scheduledDaysAhead: 7,
  scheduledWindowMinutes: 120,
  margin: { kind: 'none' },
  roundingStepMinor: 1,
  version: 0,
  currency: 'AUD',
  marketZone: 'Australia/Brisbane',
  roundingSteps: [1, 5, 10, 50, 100],
  ...patch,
});
const SELLER = '0190a000-0000-7000-8000-0000000000a1';
const methods = (patch: Partial<SellerMethods> = {}): SellerMethods => ({
  sellerId: SELLER,
  supported: ['pickup', 'instant', 'same_day', 'scheduled'],
  platformEnabled: { pickup: true, instant: true, same_day: true, scheduled: true },
  ...patch,
});
const ok = <T,>(body: T) => ({ ok: true as const, status: 200, body });
const noteRefused = {
  ok: false as const,
  failure: {
    status: 400,
    code: 'validation.failed',
    details: { fields: [{ path: 'note', code: 'required' }] },
  },
};
const pressInDialog = (name: string) =>
  fireEvent.click(screen.getByRole('button', { name, hidden: true }));
const type = (text: string) =>
  fireEvent.change(screen.getByLabelText('Note for reviewers'), { target: { value: text } });

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

describe('the Market delivery rules where a change is reviewed', () => {
  const mount = (initial: DeliverySettings) =>
    render(wrap(<DeliverySettingsPanel initial={initial} canManage csrfToken="csrf" />));
  const edit = () =>
    fireEvent.change(screen.getByLabelText('Cut-off time'), { target: { value: '10:30' } });
  const save = () => fireEvent.click(screen.getByRole('button', { name: 'Save changes' }));

  it('asks for no note and sends none when the view does not say reviewed', async () => {
    call.mockResolvedValue(ok(settings({ sameDayCutoff: '10:30', version: 1 })));
    mount(settings({ review: notReviewed }));
    expect(screen.queryByLabelText('Note for reviewers')).toBeNull();
    edit();
    save();
    pressInDialog('Confirm and save');
    await expectToast('Delivery rules saved.');
    expect(call.mock.calls[0]?.[2]).not.toHaveProperty('note');
  });

  it('needs a note, sends it trimmed, says it was sent for review and drops request', async () => {
    mount(settings({ review }));
    edit();
    save();
    expect(await screen.findByText(/Write a note for the reviewers/)).toBeTruthy();
    expect(call).not.toHaveBeenCalled();
    type('  New cut-off  ');
    call.mockResolvedValue(
      ok({
        ...settings({ sameDayCutoff: '10:30', version: 1, review }),
        request: { id: 'r1', number: 7 },
      }),
    );
    save();
    pressInDialog('Confirm and save');
    await expectToast('Sent for review (SR-7)', 'info');
    expect(call.mock.calls[0]?.[2]).toMatchObject({ note: 'New cut-off', expectedVersion: 0 });
    expect(screen.getByLabelText<HTMLTextAreaElement>('Note for reviewers').value).toBe('');
  });

  it('shows a 400 on note on the note field', async () => {
    call.mockResolvedValue(noteRefused);
    mount(settings({ review }));
    edit();
    type('x');
    save();
    pressInDialog('Confirm and save');
    expect(await screen.findByText(/The note was refused/)).toBeTruthy();
  });
});

describe('the seller delivery methods where a change is reviewed', () => {
  const mount = (initial: SellerMethods) =>
    render(wrap(<SellerMethodsCard initial={initial} canManage csrfToken="csrf" />));
  const press = () =>
    fireEvent.click(screen.getByRole('button', { name: 'Save delivery methods' }));

  it('asks for no note and sends none when not reviewed', async () => {
    call.mockResolvedValue(ok(methods({ supported: ['pickup', 'same_day', 'scheduled'] })));
    mount(methods({ review: notReviewed }));
    expect(screen.queryByLabelText('Note for reviewers')).toBeNull();
    fireEvent.click(screen.getByLabelText('Instant delivery'));
    press();
    pressInDialog('Confirm and save');
    await expectToast(/Delivery methods saved/);
    expect(call.mock.calls[0]?.[2]).toEqual({ supported: ['pickup', 'same_day', 'scheduled'] });
  });

  it('needs a note, sends it and says it was sent for review', async () => {
    mount(methods({ review }));
    fireEvent.click(screen.getByLabelText('Instant delivery'));
    press();
    expect(await screen.findByText(/Write a note for the reviewers/)).toBeTruthy();
    expect(call).not.toHaveBeenCalled();
    type('Too few riders');
    call.mockResolvedValue(
      ok({
        ...methods({ supported: ['pickup', 'same_day', 'scheduled'], review }),
        request: { id: 'r2', number: 8 },
      }),
    );
    press();
    pressInDialog('Confirm and save');
    await expectToast('Sent for review (SR-8)', 'info');
    expect(call.mock.calls[0]?.[2]).toEqual({
      supported: ['pickup', 'same_day', 'scheduled'],
      note: 'Too few riders',
    });
  });

  it('shows a 400 on note on the note field', async () => {
    call.mockResolvedValue(noteRefused);
    mount(methods({ review }));
    fireEvent.click(screen.getByLabelText('Instant delivery'));
    type('x');
    press();
    pressInDialog('Confirm and save');
    expect(await screen.findByText(/The note was refused/)).toBeTruthy();
  });
});
