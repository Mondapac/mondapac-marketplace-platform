// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { NextIntlClientProvider } from 'next-intl';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import messages from '../../messages/en.json';

const router = { refresh: vi.fn(), push: vi.fn(), replace: vi.fn() };
vi.mock('next/navigation', () => ({ useRouter: () => router }));
vi.mock('../api/client.ts', () => ({ callApi: vi.fn() }));

import { callApi } from '../api/client.ts';
import { decisionProblemOf } from './decision-errors.ts';
import { DecisionPanel } from './decision-panel.tsx';
import type { ReviewRegister } from './review-types.ts';

const call = vi.mocked(callApi);
const SELLER = '0190a000-0000-7000-8000-0000000000a1';
const REVISION = '0190a000-0000-7000-8000-0000000000b1';

const register = (over: Partial<ReviewRegister> = {}): ReviewRegister => ({
  lookup: 'none',
  state: 'not-performed',
  mismatches: [],
  staleReason: null,
  checkedAt: null,
  blocksApproval: false,
  manualCheck: null,
  ...over,
});

function mount(
  props: Partial<Parameters<typeof DecisionPanel>[0]> = {},
  reg: ReviewRegister = register(),
) {
  return render(
    <NextIntlClientProvider locale="en-AU" messages={messages}>
      <DecisionPanel
        sellerId={SELLER}
        revisionId={REVISION}
        register={reg}
        decisionInProgress={false}
        canDecide
        canCheck
        csrfToken="csrf"
        {...props}
      />
    </NextIntlClientProvider>,
  );
}

beforeEach(() => vi.clearAllMocks());
afterEach(cleanup);

describe('DecisionPanel', () => {
  it('approves the revision it was shown after one confirmation and re-reads the page', async () => {
    call.mockResolvedValue({ ok: true, status: 200, body: { decision: 'approved' } });
    mount();
    fireEvent.click(screen.getByRole('button', { name: 'Approve' }));
    expect(call).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Yes, approve' }));
    await waitFor(() => expect(router.refresh).toHaveBeenCalled());
    expect(call).toHaveBeenCalledWith(
      'POST',
      `sellers/admin/${SELLER}/review/approve`,
      { revisionId: REVISION },
      'csrf',
    );
    expect(screen.getByText('Application approved.')).toBeTruthy();
  });

  it('says the decision is settling on a 202', async () => {
    call.mockResolvedValue({ ok: true, status: 202, body: { decision: 'in-progress' } });
    mount();
    fireEvent.click(screen.getByRole('button', { name: 'Approve' }));
    fireEvent.click(screen.getByRole('button', { name: 'Yes, approve' }));
    expect(await screen.findByText(/being settled/)).toBeTruthy();
  });

  it('turns Approve off while the register blocks it, and explains why', () => {
    mount({}, register({ blocksApproval: true }));
    expect(screen.getByRole('button', { name: 'Approve' }).hasAttribute('disabled')).toBe(true);
    expect(screen.getByText(/Approval is blocked/)).toBeTruthy();
  });

  it('turns every button off while a decision is in flight', () => {
    mount({ decisionInProgress: true });
    for (const name of ['Approve', 'Reject', 'Record check']) {
      expect(screen.getByRole('button', { name }).hasAttribute('disabled')).toBe(true);
    }
  });

  it('rejects only with a reason, trimmed, and sends it with the revision', async () => {
    call.mockResolvedValue({ ok: true, status: 200, body: { decision: 'rejected' } });
    mount();
    fireEvent.click(screen.getByRole('button', { name: 'Reject' }));
    const submit = screen.getByRole('button', { name: 'Reject application' });
    expect(submit.hasAttribute('disabled')).toBe(true);
    fireEvent.change(screen.getByLabelText('Reason'), { target: { value: ' ABN not active ' } });
    fireEvent.click(submit);
    await waitFor(() => expect(call).toHaveBeenCalledTimes(1));
    expect(call).toHaveBeenCalledWith(
      'POST',
      `sellers/admin/${SELLER}/review/reject`,
      { revisionId: REVISION, reason: 'ABN not active' },
      'csrf',
    );
  });

  it('records a manual check with the chosen outcome', async () => {
    call.mockResolvedValue({ ok: true, status: 200, body: { observedOutcome: 'active' } });
    mount();
    const record = screen.getByRole('button', { name: 'Record check' });
    expect(record.hasAttribute('disabled')).toBe(true);
    fireEvent.change(screen.getByLabelText('What the register shows'), {
      target: { value: 'active' },
    });
    fireEvent.click(record);
    await waitFor(() => expect(call).toHaveBeenCalledTimes(1));
    expect(call).toHaveBeenCalledWith(
      'PUT',
      `sellers/admin/${SELLER}/review/manual-register-check`,
      { revisionId: REVISION, observedOutcome: 'active' },
      'csrf',
    );
    expect(await screen.findByText('Manual check recorded.')).toBeTruthy();
  });

  it('shows the recorded manual check', () => {
    mount(
      {},
      register({
        manualCheck: { observedOutcome: 'active', recordedAt: '2026-10-10T01:00:00.000Z' },
      }),
    );
    expect(screen.getByText(/Recorded: Active/)).toBeTruthy();
  });

  it('keeps the confirmation open and offers a re-read when the revision is stale', async () => {
    call.mockResolvedValue({
      ok: false,
      failure: { status: 409, code: 'review.not-current-revision' },
    });
    mount();
    fireEvent.click(screen.getByRole('button', { name: 'Approve' }));
    fireEvent.click(screen.getByRole('button', { name: 'Yes, approve' }));
    expect(await screen.findByText(/changed the application/)).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Read the application again' }));
    expect(router.refresh).toHaveBeenCalledTimes(1);
  });

  it('hides the decision buttons without the approve permission', () => {
    mount({ canDecide: false });
    expect(screen.queryByRole('button', { name: 'Approve' })).toBeNull();
    expect(screen.getByRole('button', { name: 'Record check' })).toBeTruthy();
  });

  it('sends a double click once', async () => {
    let resolve: (value: never) => void = () => undefined;
    call.mockImplementationOnce(() => new Promise((r) => (resolve = r)));
    mount();
    fireEvent.click(screen.getByRole('button', { name: 'Approve' }));
    const yes = screen.getByRole('button', { name: 'Yes, approve' });
    fireEvent.click(yes);
    fireEvent.click(yes);
    expect(call).toHaveBeenCalledTimes(1);
    resolve({ ok: false, failure: { status: 503, code: 'x' } } as never);
    expect(await screen.findByText(/could not be sent/)).toBeTruthy();
  });
});

describe('decisionProblemOf', () => {
  it('names the register and state refusals and flags stale screens', () => {
    expect(decisionProblemOf({ status: 409, code: 'review.register-negative' }).key).toBe(
      'sellers.decision.error.register-negative',
    );
    expect(decisionProblemOf({ status: 409, code: 'seller-access.wrong-state' }).reload).toBe(true);
    expect(decisionProblemOf({ status: 409, code: 'review.identifier-claimed' }).reload).toBe(
      false,
    );
    expect(
      decisionProblemOf({
        status: 400,
        code: 'validation.failed',
        details: { fields: [{ path: 'reason', code: 'length' }] },
      }).reasonInvalid,
    ).toBe(true);
  });
});
