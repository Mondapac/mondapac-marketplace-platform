// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { NextIntlClientProvider } from 'next-intl';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import messages from '../../messages/en.json';

vi.mock('../api/client.ts', () => ({ callApi: vi.fn() }));

import { callApi } from '../api/client.ts';
import { expectToast } from '../../test/toast-spy.ts';
import { ReviewPolicyPanel } from './review-policy.tsx';
import { POLICY_AREAS, type AreaPolicy, type ReviewPolicy } from './types.ts';

const call = vi.mocked(callApi);
const ok = (body: unknown) => ({ ok: true as const, status: 200, body });
const refused = (status: number, code: string) => ({
  ok: false as const,
  failure: { status, code },
});

const area = (name: AreaPolicy['area'], over: Partial<AreaPolicy> = {}): AreaPolicy => ({
  area: name,
  enabled: true,
  risk: 'medium',
  reviewPermission: `system-requests.${name}.review`,
  version: 0,
  updatedAt: null,
  updatedBy: null,
  ...over,
});
const policy = (): ReviewPolicy => ({
  areas: POLICY_AREAS.map((name) =>
    name === 'money'
      ? area(name, { version: 2, updatedAt: '2026-11-01T01:00:00.000Z', updatedByName: 'Sara K.' })
      : area(name),
  ),
  reviewDueDays: { reviewDueDays: 7, version: 0, updatedAt: null, updatedBy: null },
  reviewPolicy: { risk: 'high', reviewPermission: 'system-requests.policy.review' },
});
const pendingPage = {
  rows: [{ id: '0190a000-0000-7000-8000-000000000555', number: 55, subjectRef: 'delivery' }],
};

function route(put: unknown = ok({})) {
  call.mockImplementation((method, path) => {
    if (method === 'GET' && String(path).includes('review-policy')) {
      return Promise.resolve(ok(policy()));
    }
    if (method === 'GET') return Promise.resolve(ok(pendingPage));
    return Promise.resolve(put as never);
  });
}

function mount(props: { canManage?: boolean; canSeeRequests?: boolean } = {}) {
  return render(
    <NextIntlClientProvider locale="en-AU" messages={messages}>
      <ReviewPolicyPanel
        canManage={props.canManage ?? true}
        canSeeRequests={props.canSeeRequests ?? true}
        csrfToken="csrf"
        zone="Australia/Brisbane"
      />
    </NextIntlClientProvider>,
  );
}

async function openDialog(): Promise<HTMLElement> {
  fireEvent.click(await screen.findByRole('button', { name: 'Save change' }));
  return (await screen.findByRole('heading', { name: 'Save policy change' })).closest(
    'dialog',
  ) as HTMLElement;
}

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

describe('ReviewPolicyPanel', () => {
  it('lists every area with its switch, who changed it and the open request', async () => {
    route();
    mount();
    expect(await screen.findByRole('heading', { name: 'Review policy' })).toBeTruthy();
    expect((await screen.findAllByRole('switch')).length).toBe(POLICY_AREAS.length);
    expect(screen.getByText(/by Sara K\./)).toBeTruthy();
    expect(await screen.findByText('Awaiting review SR-55')).toBeTruthy();
  });

  it('asks for the open requests only when the admin may see requests', async () => {
    route();
    mount({ canSeeRequests: false });
    await screen.findByRole('heading', { name: 'Review policy' });
    expect(call.mock.calls.every(([, path]) => String(path).includes('review-policy'))).toBe(true);
  });

  it('is read-only without the manage permission', async () => {
    route();
    mount({ canManage: false });
    await screen.findByRole('heading', { name: 'Review policy' });
    expect(screen.getByText('You can view the policy but not change it.')).toBeTruthy();
    for (const box of screen.getAllByRole('switch')) {
      expect(box.hasAttribute('disabled') || box.getAttribute('aria-disabled') === 'true').toBe(
        true,
      );
    }
    expect(screen.queryByRole('button', { name: 'Save change' })).toBeNull();
  });

  it('shows an error with a retry when the policy cannot be loaded', async () => {
    call.mockResolvedValue(refused(500, 'internal'));
    mount();
    expect(
      await screen.findByText('The review policy could not be loaded. Try again.'),
    ).toBeTruthy();
  });

  it('saves a change with a note, says which request was opened and closes the dialog', async () => {
    route(
      ok({
        value: area('delivery', { enabled: false, version: 1 }),
        request: { id: '0190a000-0000-7000-8000-000000000777', number: 77, displayNumber: 'SR-77' },
      }),
    );
    mount();
    await screen.findByRole('heading', { name: 'Review policy' });
    fireEvent.click(screen.getByRole('switch', { name: 'Review changes in Delivery' }));
    const dialog = await openDialog();
    expect(within(dialog).getByText(/Delivery: review turned off/)).toBeTruthy();
    expect(
      within(dialog).getByText('Changes in this area will no longer be reviewed.'),
    ).toBeTruthy();
    fireEvent.click(within(dialog).getByRole('button', { name: 'Save and send for review' }));
    expect(await within(dialog).findByText(/Write a note/)).toBeTruthy();
    fireEvent.change(within(dialog).getByRole('textbox'), { target: { value: ' Pilot ends ' } });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Save and send for review' }));
    await expectToast('Saved. Review request SR-77 opened.');
    expect(call).toHaveBeenCalledWith(
      'PUT',
      'system-requests/admin/review-policy/areas/delivery',
      { enabled: false, risk: 'medium', expectedVersion: 0, note: 'Pilot ends' },
      'csrf',
    );
    await waitFor(() =>
      expect(screen.queryByRole('heading', { name: 'Save policy change' })).toBeNull(),
    );
  });

  it('says nothing changed when the server opens no request', async () => {
    route(ok({ value: area('people', { risk: 'high', version: 1 }), request: null }));
    mount();
    await screen.findByRole('heading', { name: 'Review policy' });
    fireEvent.change(screen.getByLabelText('Risk for People'), { target: { value: 'high' } });
    const dialog = await openDialog();
    fireEvent.change(within(dialog).getByRole('textbox'), { target: { value: 'Tighten' } });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Save and send for review' }));
    await expectToast('Nothing changed.', 'info');
  });

  it('shows the latest values and a notice when someone saved first', async () => {
    route(refused(409, 'system-requests.policy-conflict'));
    mount();
    await screen.findByRole('heading', { name: 'Review policy' });
    fireEvent.click(screen.getByRole('switch', { name: 'Review changes in Content' }));
    const dialog = await openDialog();
    fireEvent.change(within(dialog).getByRole('textbox'), { target: { value: 'Because' } });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Save and send for review' }));
    expect(await screen.findByText(/Someone else changed this policy first/)).toBeTruthy();
  });

  it('saves the review period and flags a value outside 1 to 90', async () => {
    route(
      ok({
        value: {
          reviewDueDays: 10,
          version: 1,
          updatedAt: '2026-11-16T01:00:00.000Z',
          updatedBy: null,
        },
        request: { id: '0190a000-0000-7000-8000-000000000778', number: 78, displayNumber: 'SR-78' },
      }),
    );
    mount();
    await screen.findByRole('heading', { name: 'Review policy' });
    const field = screen.getByLabelText('Days before an open request is overdue');
    fireEvent.change(field, { target: { value: '120' } });
    expect(await screen.findByText('Enter 1 to 90.')).toBeTruthy();
    fireEvent.change(field, { target: { value: '10' } });
    const dialog = await openDialog();
    expect(within(dialog).getByText('Review period: 7 to 10 days')).toBeTruthy();
    fireEvent.change(within(dialog).getByRole('textbox'), { target: { value: 'Slower weeks' } });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Save and send for review' }));
    await expectToast('Saved. Review request SR-78 opened.');
    expect(call).toHaveBeenCalledWith(
      'PUT',
      'system-requests/admin/review-policy/review-due-days',
      { reviewDueDays: 10, expectedVersion: 0, note: 'Slower weeks' },
      'csrf',
    );
  });
});
