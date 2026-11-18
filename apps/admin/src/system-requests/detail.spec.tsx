// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { NextIntlClientProvider } from 'next-intl';
import type { ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import messages from '../../messages/en.json';

vi.mock('../api/client.ts', () => ({ callApi: vi.fn() }));

import { callApi } from '../api/client.ts';
import { expectToast } from '../../test/toast-spy.ts';
import { STEP_UP_CANCELLED, StepUpProvider } from '../step-up/step-up.tsx';
import { RequestDetail } from './request-detail.tsx';
import type { SystemRequestDetail } from './types.ts';

const call = vi.mocked(callApi);
const ME = '0190a000-0000-7000-8000-0000000000a1';
const OTHER = '0190a000-0000-7000-8000-0000000000b2';
const ID = '0190a000-0000-7000-8000-000000000101';
const ok = (body: unknown) => ({ ok: true as const, status: 200, body });
const refused = (status: number, code: string, details?: object) => ({
  ok: false as const,
  failure: { status, code, ...(details === undefined ? {} : { details }) },
});

const detail = (over: Partial<SystemRequestDetail> = {}): SystemRequestDetail => ({
  id: ID,
  number: 1042,
  displayNumber: 'SR-1042',
  area: 'money',
  subjectKind: 'commission-payouts.commission-rate',
  subjectRef: '0190a000-0000-7000-8000-0000000009ff',
  risk: 'medium',
  status: 'open',
  mode: 'review',
  before: { rateBps: 1500, label: 'standard' },
  after: { rateBps: 1200, label: 'standard' },
  note: 'Lower the rate\nfor the pilot <b>sellers</b>',
  requestedBy: OTHER,
  requestedByName: 'Sara K.',
  appliedAt: '2026-11-10T01:00:00.000Z',
  reviewDueAt: '2026-11-17T01:00:00.000Z',
  overdue: false,
  decision: null,
  decidedBy: null,
  decidedAt: null,
  decisionReason: null,
  supersededBy: null,
  commentCount: 1,
  reviewPermission: 'system-requests.money.review',
  actions: ['open', 'copy-link', 'approve', 'reject'],
  activity: [
    {
      id: 'a1',
      kind: 'applied',
      actor: OTHER,
      actorName: 'Sara K.',
      at: '2026-11-10T01:00:00.000Z',
      body: null,
    },
    {
      id: 'a2',
      kind: 'commented',
      actor: OTHER,
      at: '2026-11-11T01:00:00.000Z',
      body: 'Agreed with finance.',
    },
    { id: 'a3', kind: 'mystery', actor: OTHER, at: '2026-11-12T01:00:00.000Z', body: null },
  ],
  ...over,
});

function Wrap({ on, children }: { on: boolean; children: ReactNode }) {
  return on ? <StepUpProvider>{children}</StepUpProvider> : <>{children}</>;
}
function mount(withStepUp = false) {
  return render(
    <NextIntlClientProvider locale="en-AU" messages={messages}>
      <Wrap on={withStepUp}>
        <RequestDetail
          requestId={ID}
          accountId={ME}
          csrfToken="csrf"
          zone="Australia/Brisbane"
          marketId="AU"
        />
      </Wrap>
    </NextIntlClientProvider>,
  );
}
const open = (kind: 'Approve' | 'Reject and revert' | 'Withdraw my change') =>
  fireEvent.click(screen.getByRole('button', { name: kind }));

beforeEach(() => {
  vi.resetAllMocks();
  window.localStorage.clear();
  HTMLDialogElement.prototype.showModal = function showModal() {
    this.setAttribute('open', '');
  };
  HTMLDialogElement.prototype.close = function close() {
    this.removeAttribute('open');
  };
});
afterEach(cleanup);

describe('RequestDetail', () => {
  it('shows the header, facts, note as plain text, the diff and the history', async () => {
    call.mockResolvedValue(ok(detail()));
    mount();
    expect(
      await screen.findByRole('heading', { level: 1, name: 'SR-1042 Commission rate' }),
    ).toBeTruthy();
    expect(call).toHaveBeenCalledWith('GET', `system-requests/admin/requests/${ID}`);
    expect(screen.getAllByText('Money').length).toBeGreaterThan(0);
    expect(screen.getByText('Medium')).toBeTruthy();
    expect(screen.getByText('Sara K.', { selector: 'dd' })).toBeTruthy();
    // The author's note is text, never markup.
    expect(screen.getByText(/Lower the rate/).textContent).toContain('<b>sellers</b>');
    expect(screen.queryByRole('strong')).toBeNull();
    // The changed field is shown with both sides, the unchanged one behind a disclosure.
    const card = screen
      .getByRole('heading', { name: 'What changed' })
      .closest('section') as HTMLElement;
    expect(within(card).getByText('Rate bps')).toBeTruthy();
    expect(within(card).getByText('15%')).toBeTruthy();
    expect(within(card).getByText('12%')).toBeTruthy();
    expect(within(card).getAllByText('changed', { exact: false }).length).toBeGreaterThan(0);
    fireEvent.click(within(card).getByRole('button', { name: '1 unchanged field' }));
    expect(within(card).getAllByText('standard').length).toBeTruthy();
    // History: oldest first, with a word for a kind the panel does not know.
    expect(screen.getByText('applied the change')).toBeTruthy();
    expect(screen.getByText('Agreed with finance.')).toBeTruthy();
    expect(screen.getByText('updated')).toBeTruthy();
    // Open and live.
    expect(
      screen.getByText(
        'This change is already live. Approve to keep it, or reject to put the previous value back.',
      ),
    ).toBeTruthy();
  });

  it('says who may see the values when the API sent none', async () => {
    call.mockResolvedValue(ok(detail({ before: null, after: null })));
    mount();
    expect(
      await screen.findByText(
        'The values are visible only to the author and reviewers of this area.',
      ),
    ).toBeTruthy();
  });

  it('shows a null rate as the Market default', async () => {
    call.mockResolvedValue(ok(detail({ before: { rateBps: null }, after: { rateBps: 900 } })));
    mount();
    expect(await screen.findByText('Market default')).toBeTruthy();
    expect(screen.getByText('9%')).toBeTruthy();
  });

  it('offers only the actions the API listed', async () => {
    call.mockResolvedValue(ok(detail({ actions: ['open', 'copy-link'] })));
    mount();
    await screen.findByRole('heading', { level: 1 });
    expect(screen.queryByRole('button', { name: 'Approve' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Reject and revert' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Withdraw my change' })).toBeNull();
    expect(screen.getByRole('button', { name: 'Copy link' })).toBeTruthy();
  });

  it('shows the author their own request and the withdraw action', async () => {
    call.mockResolvedValue(
      ok(detail({ requestedBy: ME, actions: ['open', 'copy-link', 'withdraw'] })),
    );
    mount();
    expect(
      await screen.findByText(
        'You made this change. Another admin has to approve it. You can withdraw it.',
      ),
    ).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Withdraw my change' })).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Approve' })).toBeNull();
  });

  it('warns that a later request superseded this one and links to it', async () => {
    const later = '0190a000-0000-7000-8000-000000000202';
    call.mockResolvedValue(
      ok(detail({ supersededBy: later, supersededByNumber: 1050, actions: ['open', 'approve'] })),
    );
    mount();
    expect(
      await screen.findByText(
        /A later request changed this again, so this one can no longer be reverted\. You can still approve it\./,
      ),
    ).toBeTruthy();
    expect(
      screen.getByRole('link', { name: 'See the later request (SR-1050)' }).getAttribute('href'),
    ).toBe(`/system-requests/${later}`);
    expect(screen.queryByText(/This change is already live/)).toBeNull();
    expect(screen.getByText('Superseded')).toBeTruthy();
  });

  it('falls back to SR-? when the later request has no number', async () => {
    call.mockResolvedValue(
      ok(detail({ supersededBy: '0190a000-0000-7000-8000-000000000202', actions: ['open'] })),
    );
    mount();
    expect(await screen.findByRole('link', { name: 'See the later request (SR-?)' })).toBeTruthy();
  });

  it.each([
    [
      'approved',
      {
        status: 'approved',
        decision: 'approved',
        decidedBy: ME,
        decidedAt: '2026-11-12T01:00:00.000Z',
      },
      'Approved by you on 12 Nov 2026. The change stayed live.',
    ],
    [
      'rejected',
      {
        status: 'reverted',
        decision: 'rejected',
        decidedBy: OTHER,
        decidedByName: 'Omar L.',
        decidedAt: '2026-11-12T01:00:00.000Z',
        decisionReason: 'Too low',
      },
      'Rejected by Omar L. on 12 Nov 2026. Reason: Too low.',
    ],
    [
      'withdrawn',
      {
        status: 'reverted',
        decision: 'withdrawn',
        decidedBy: OTHER,
        decidedByName: 'Sara K.',
        decidedAt: '2026-11-12T01:00:00.000Z',
        decisionReason: 'Mistake',
      },
      'Withdrawn by Sara K. on 12 Nov 2026. Reason: Mistake.',
    ],
  ] as const)(
    'shows the outcome line of a %s request and no actions',
    async (_name, over, text) => {
      call.mockResolvedValue(ok(detail({ ...over, actions: ['open', 'copy-link', 'approve'] })));
      mount();
      expect(await screen.findByText(text)).toBeTruthy();
      expect(screen.queryByRole('button', { name: 'Approve' })).toBeNull();
      expect(
        screen.getByRole('heading', { name: 'Values at the time of the change' }),
      ).toBeTruthy();
    },
  );

  it('shows the not-found message and a link to the queue', async () => {
    call.mockResolvedValue(refused(404, 'system-requests.not-found'));
    mount();
    expect(
      await screen.findByText('This request does not exist or you cannot see it.'),
    ).toBeTruthy();
    expect(screen.getAllByRole('link', { name: 'System requests' })[0]?.getAttribute('href')).toBe(
      '/system-requests',
    );
  });

  it('keeps the queue address in the Back link', async () => {
    window.localStorage.setItem(
      'mp:admin:AU:' + ME + ':system-requests-query',
      '["view=all&risk=high"]',
    );
    call.mockResolvedValue(ok(detail()));
    mount();
    await screen.findByRole('heading', { level: 1 });
    await waitFor(() =>
      expect(screen.getByRole('link', { name: 'System requests' }).getAttribute('href')).toBe(
        '/system-requests?view=all&risk=high',
      ),
    );
  });
});

describe('RequestDetail decisions', () => {
  it('approves after a confirmation, says so, and loads the request again', async () => {
    call.mockResolvedValueOnce(ok(detail()));
    mount();
    await screen.findByRole('heading', { level: 1 });
    open('Approve');
    expect(await screen.findByRole('heading', { name: 'Approve SR-1042?' })).toBeTruthy();
    expect(
      screen.getByText('The change stays live exactly as it is. This cannot be undone.'),
    ).toBeTruthy();
    expect(screen.queryByText(/two-step code/)).toBeNull();
    call.mockResolvedValueOnce(ok(detail({ status: 'approved' })));
    call.mockResolvedValueOnce(
      ok(
        detail({
          status: 'approved',
          decision: 'approved',
          decidedBy: ME,
          decidedAt: '2026-11-12T01:00:00.000Z',
          actions: ['open'],
        }),
      ),
    );
    const dialog = screen
      .getByRole('heading', { name: 'Approve SR-1042?' })
      .closest('dialog') as HTMLElement;
    fireEvent.click(within(dialog).getByRole('button', { name: 'Approve' }));
    await expectToast('SR-1042 approved. The change stays live.');
    expect(call).toHaveBeenCalledWith(
      'POST',
      `system-requests/admin/requests/${ID}/approve`,
      undefined,
      'csrf',
    );
    expect(await screen.findByText(/Approved by you on/)).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Approve' })).toBeNull();
  });

  it('warns on a high-risk approve that a two-step code follows, and stays quiet when it is cancelled', async () => {
    call.mockResolvedValueOnce(ok(detail({ risk: 'high' })));
    mount();
    await screen.findByRole('heading', { level: 1 });
    open('Approve');
    expect(
      await screen.findByText('High risk: you will be asked for your two-step code.'),
    ).toBeTruthy();
    call.mockResolvedValueOnce({
      ok: false,
      failure: { status: 0, code: STEP_UP_CANCELLED },
    });
    const dialog = screen
      .getByRole('heading', { name: 'Approve SR-1042?' })
      .closest('dialog') as HTMLElement;
    fireEvent.click(within(dialog).getByRole('button', { name: 'Approve' }));
    await waitFor(() =>
      expect(screen.queryByRole('heading', { name: 'Approve SR-1042?' })).toBeNull(),
    );
    // Nothing was said, and the request is still open.
    expect(screen.queryByRole('alert')).toBeNull();
    expect(screen.getByRole('button', { name: 'Approve' })).toBeTruthy();
    expect(call).toHaveBeenCalledTimes(2);
  });

  it('asks for a reason before it rejects, and sends it', async () => {
    call.mockResolvedValueOnce(ok(detail()));
    mount();
    await screen.findByRole('heading', { level: 1 });
    open('Reject and revert');
    const dialog = (
      await screen.findByRole('heading', {
        name: 'Reject SR-1042 and put the previous value back?',
      })
    ).closest('dialog') as HTMLElement;
    expect(
      within(dialog).getByText(
        /The platform returns to the value before this change, in one step\./,
      ),
    ).toBeTruthy();
    fireEvent.click(within(dialog).getByRole('button', { name: 'Reject and revert' }));
    expect(within(dialog).getByText('Enter a reason.')).toBeTruthy();
    expect(call).toHaveBeenCalledTimes(1);
    fireEvent.change(within(dialog).getByLabelText('Reason (shown to the author)'), {
      target: { value: '  Too low for this seller  ' },
    });
    expect(within(dialog).getByText(/27 \/ 500/)).toBeTruthy();
    call.mockResolvedValueOnce(ok(detail({ status: 'reverted' })));
    call.mockResolvedValueOnce(
      ok(detail({ status: 'reverted', decision: 'rejected', actions: [] })),
    );
    fireEvent.click(within(dialog).getByRole('button', { name: 'Reject and revert' }));
    await expectToast('SR-1042 rejected. The previous value is back in place.');
    expect(call).toHaveBeenCalledWith(
      'POST',
      `system-requests/admin/requests/${ID}/reject`,
      { reason: 'Too low for this seller' },
      'csrf',
    );
  });

  it('withdraws the author’s own change with a reason', async () => {
    call.mockResolvedValueOnce(ok(detail({ requestedBy: ME, actions: ['open', 'withdraw'] })));
    mount();
    await screen.findByRole('heading', { level: 1 });
    open('Withdraw my change');
    const dialog = (await screen.findByRole('heading', { name: 'Withdraw your change?' })).closest(
      'dialog',
    ) as HTMLElement;
    fireEvent.change(within(dialog).getByLabelText('Reason'), { target: { value: 'Typo' } });
    call.mockResolvedValueOnce(ok(detail({ status: 'reverted' })));
    call.mockResolvedValueOnce(
      ok(detail({ status: 'reverted', decision: 'withdrawn', actions: [] })),
    );
    fireEvent.click(within(dialog).getByRole('button', { name: 'Withdraw change' }));
    await expectToast('Your change was withdrawn. The previous value is back in place.');
    expect(call).toHaveBeenCalledWith(
      'POST',
      `system-requests/admin/requests/${ID}/withdraw`,
      { reason: 'Typo' },
      'csrf',
    );
  });

  it('shows a field error from the API on the reason', async () => {
    call.mockResolvedValueOnce(ok(detail()));
    mount();
    await screen.findByRole('heading', { level: 1 });
    open('Reject and revert');
    const dialog = (
      await screen.findByRole('heading', {
        name: 'Reject SR-1042 and put the previous value back?',
      })
    ).closest('dialog') as HTMLElement;
    fireEvent.change(within(dialog).getByLabelText('Reason (shown to the author)'), {
      target: { value: 'x' },
    });
    call.mockResolvedValueOnce(
      refused(400, 'validation.failed', { fields: [{ path: 'reason', code: 'length' }] }),
    );
    fireEvent.click(within(dialog).getByRole('button', { name: 'Reject and revert' }));
    expect(await within(dialog).findByText('Write 1 to 500 characters.')).toBeTruthy();
  });

  describe('refusals', () => {
    async function refuse(
      failure: ReturnType<typeof refused>,
      opener: 'Approve' | 'Reject and revert' = 'Approve',
    ) {
      call.mockResolvedValueOnce(ok(detail()));
      mount();
      await screen.findByRole('heading', { level: 1 });
      open(opener);
      if (opener === 'Reject and revert') {
        const dialog = (
          await screen.findByRole('heading', {
            name: 'Reject SR-1042 and put the previous value back?',
          })
        ).closest('dialog') as HTMLElement;
        fireEvent.change(within(dialog).getByLabelText('Reason (shown to the author)'), {
          target: { value: 'No' },
        });
      }
      call.mockResolvedValueOnce(failure);
      call.mockResolvedValueOnce(ok(detail()));
      const dialog = (await screen.findAllByRole('dialog'))[0] as HTMLElement;
      fireEvent.click(within(dialog).getAllByRole('button').at(-1) as HTMLElement);
    }

    it('says the value changed again, and links to the newer request', async () => {
      const newer = '0190a000-0000-7000-8000-000000000303';
      await refuse(
        refused(409, 'system-requests.changed-since', { newerRequestId: newer }),
        'Reject and revert',
      );
      expect(
        await screen.findByText(
          /The value was changed again after this request, so it was not reverted and nothing was put back\. Review the newer request instead\./,
        ),
      ).toBeTruthy();
      expect(
        screen.getByRole('link', { name: 'Open the newer request' }).getAttribute('href'),
      ).toBe(`/system-requests/${newer}`);
      // The request stays open and can still be approved.
      expect(screen.getByRole('button', { name: 'Approve' })).toBeTruthy();
    });

    it('has no link when the API names no newer request', async () => {
      await refuse(
        refused(409, 'system-requests.changed-since', { newerRequestId: null }),
        'Reject and revert',
      );
      await screen.findByText(/The value was changed again/);
      expect(screen.queryByRole('link', { name: 'Open the newer request' })).toBeNull();
    });

    it.each([
      ['system-requests.subject-gone', 409, /The item this change was about no longer exists/],
      [
        'system-requests.revert-not-permitted',
        403,
        /You are not allowed to make the change that reverting would make/,
      ],
      [
        'system-requests.own-request',
        403,
        /You made this change, so you cannot approve or reject it\./,
      ],
      [
        'system-requests.own-subject',
        403,
        /You made this change, so you cannot approve or reject it\./,
      ],
      ['system-requests.not-author', 403, /Only the admin who made this change can withdraw it\./],
      ['system-requests.decided', 409, /Someone else already decided this request\./],
      ['request.csrf', 403, /Your session expired\. Reload the page\./],
      ['access.denied', 403, /You do not have permission for this\./],
    ])('words %s', async (code, status, text) => {
      await refuse(refused(status, code));
      expect(await screen.findByText(text)).toBeTruthy();
    });

    it('names the review permission when the admin does not hold it', async () => {
      await refuse(refused(403, 'system-requests.not-reviewer'));
      expect(
        await screen.findByText(
          'You do not hold the review permission for this area (system-requests.money.review).',
        ),
      ).toBeTruthy();
    });

    it('offers Try again when reverting is unavailable, and keeps the reason', async () => {
      await refuse(refused(503, 'system-requests.revert-unavailable'), 'Reject and revert');
      expect(
        await screen.findByText(
          'Reverting is not available right now. Nothing was changed. Try again in a moment.',
        ),
      ).toBeTruthy();
      fireEvent.click(screen.getByRole('button', { name: 'Try again' }));
      expect(
        (await screen.findByLabelText<HTMLTextAreaElement>('Reason (shown to the author)')).value,
      ).toBe('No');
    });

    it('says nothing was changed on a network failure', async () => {
      await refuse({ ok: false, failure: { status: 0, code: 'network' } });
      expect(
        await screen.findByText('Could not reach the server. Nothing was changed.'),
      ).toBeTruthy();
      expect(screen.getByRole('button', { name: 'Try again' })).toBeTruthy();
    });

    it('links to the profile when two-step verification is not set up', async () => {
      await refuse(refused(403, 'second-factor.enrolment-required'));
      expect(
        await screen.findByText(
          /Set up two-step verification on your profile to review high-risk requests\./,
        ),
      ).toBeTruthy();
      expect(screen.getByRole('link', { name: 'Open your profile' }).getAttribute('href')).toBe(
        '/account/profile',
      );
    });
  });
});

describe('RequestDetail comments', () => {
  it('adds a comment to the list, clears the box and announces it', async () => {
    call.mockResolvedValueOnce(ok(detail()));
    mount();
    await screen.findByRole('heading', { level: 1 });
    const box = screen.getByLabelText<HTMLTextAreaElement>('Add a comment');
    fireEvent.change(box, { target: { value: '  Looks fine  ' } });
    expect(screen.getByText(/14 \/ 2000/)).toBeTruthy();
    call.mockResolvedValueOnce(
      ok({
        id: 'a9',
        kind: 'commented',
        actor: ME,
        at: '2026-11-13T01:00:00.000Z',
        body: 'Looks fine',
      }),
    );
    fireEvent.click(screen.getByRole('button', { name: 'Comment' }));
    expect(await screen.findByText('Looks fine')).toBeTruthy();
    expect(call).toHaveBeenCalledWith(
      'POST',
      `system-requests/admin/requests/${ID}/comments`,
      { body: 'Looks fine' },
      'csrf',
    );
    expect(box.value).toBe('');
    expect(screen.getByText('Comment added')).toBeTruthy();
  });

  it('says what is wrong with an empty or refused comment', async () => {
    call.mockResolvedValueOnce(ok(detail()));
    mount();
    await screen.findByRole('heading', { level: 1 });
    fireEvent.click(screen.getByRole('button', { name: 'Comment' }));
    expect(screen.getByText('Write 1 to 2000 characters.')).toBeTruthy();
    fireEvent.change(screen.getByLabelText('Add a comment'), { target: { value: 'Hello' } });
    call.mockResolvedValueOnce(refused(503, 'access.unavailable'));
    fireEvent.click(screen.getByRole('button', { name: 'Comment' }));
    expect(await screen.findByText('Could not post the comment. Try again.')).toBeTruthy();
    expect(screen.getByLabelText<HTMLTextAreaElement>('Add a comment').value).toBe('Hello');
  });
});

describe('RequestDetail high-risk step-up', () => {
  const required = refused(403, 'second-factor.required', {
    actionKey: 'system-requests.request.decide-high',
  });
  const verified = ok({ code: 'step-up-verified' });
  const enter = async () => {
    await screen.findByRole('dialog', { name: 'Confirm it is you' });
    const boxes = screen.getAllByRole('textbox', { name: /Digit \d of 6/ });
    fireEvent.paste(boxes[0] as HTMLElement, { clipboardData: { getData: () => '123456' } });
  };

  it('approves after the code is entered and the call is repeated', async () => {
    call.mockResolvedValueOnce(ok(detail({ risk: 'high' })));
    mount(true);
    await screen.findByRole('heading', { level: 1 });
    open('Approve');
    const dialog = (await screen.findByRole('heading', { name: 'Approve SR-1042?' })).closest(
      'dialog',
    ) as HTMLElement;
    call.mockResolvedValueOnce(required);
    call.mockResolvedValueOnce(verified);
    call.mockResolvedValueOnce(ok(detail({ risk: 'high', status: 'approved' })));
    call.mockResolvedValueOnce(ok(detail({ risk: 'high', status: 'approved', actions: [] })));
    fireEvent.click(within(dialog).getByRole('button', { name: 'Approve' }));
    await enter();
    await expectToast('SR-1042 approved. The change stays live.');
    const posts = call.mock.calls.filter(([method]) => method === 'POST');
    expect(posts.map(([, path]) => path)).toEqual([
      `system-requests/admin/requests/${ID}/approve`,
      'identity/admin/step-up/verify',
      `system-requests/admin/requests/${ID}/approve`,
    ]);
    expect(posts[1]?.[2]).toEqual({
      actionKey: 'system-requests.request.decide-high',
      code: '123456',
    });
  });

  it('rejects with the reason after the code is entered and the call is repeated', async () => {
    call.mockResolvedValueOnce(ok(detail({ risk: 'high' })));
    mount(true);
    await screen.findByRole('heading', { level: 1 });
    open('Reject and revert');
    const dialog = (
      await screen.findByRole('heading', {
        name: 'Reject SR-1042 and put the previous value back?',
      })
    ).closest('dialog') as HTMLElement;
    fireEvent.change(within(dialog).getByLabelText('Reason (shown to the author)'), {
      target: { value: 'Too low' },
    });
    call.mockResolvedValueOnce(required);
    call.mockResolvedValueOnce(verified);
    call.mockResolvedValueOnce(ok(detail({ risk: 'high', status: 'reverted' })));
    call.mockResolvedValueOnce(ok(detail({ risk: 'high', status: 'reverted', actions: [] })));
    fireEvent.click(within(dialog).getByRole('button', { name: 'Reject and revert' }));
    await enter();
    await waitFor(() =>
      expect(call.mock.calls.filter(([method]) => method === 'POST')).toHaveLength(3),
    );
    const posts = call.mock.calls.filter(([method]) => method === 'POST');
    expect(posts[0]).toEqual([
      'POST',
      `system-requests/admin/requests/${ID}/reject`,
      { reason: 'Too low' },
      'csrf',
    ]);
    expect(posts[2]).toEqual(posts[0]);
  });

  describe('an action that waits for approval', () => {
    const proposal = (over: Partial<SystemRequestDetail> = {}) =>
      detail({
        mode: 'approval',
        subjectKind: 'catalog.brand',
        before: { name: 'Acme Foods', products: 12 },
        after: { action: 'merge', intoId: 'b-2', intoName: 'Acme Foods Pty' },
        activity: [
          {
            id: 'p1',
            kind: 'proposed',
            actor: OTHER,
            actorName: 'Sara K.',
            at: '2026-11-10T01:00:00.000Z',
            body: null,
          },
        ],
        ...over,
      });

    it('shows the badge, the requested action and the current values, with no diff', async () => {
      call.mockResolvedValue(ok(proposal()));
      mount();
      await screen.findByRole('heading', { level: 1 });
      expect(screen.getByText('Waits for approval')).toBeTruthy();
      expect(screen.getByRole('heading', { name: 'Requested action' })).toBeTruthy();
      expect(screen.getByText('Merge into Acme Foods Pty')).toBeTruthy();
      expect(screen.getByRole('heading', { name: 'What the subject holds now' })).toBeTruthy();
      expect(screen.getByText('Acme Foods')).toBeTruthy();
      expect(screen.queryByRole('heading', { name: 'What changed' })).toBeNull();
      expect(screen.queryByText(/This change is already live/)).toBeNull();
      expect(screen.getByText(/Nothing has changed yet\./)).toBeTruthy();
      expect(screen.getByText('asked for the action')).toBeTruthy();
    });

    it('names a plain action and says what to expect from each decision', async () => {
      call.mockResolvedValue(ok(proposal({ after: { action: 'delete' } })));
      mount();
      await screen.findByRole('heading', { level: 1 });
      expect(screen.getByText('Delete')).toBeTruthy();
      open('Approve');
      expect(
        await screen.findByRole('heading', { name: 'Approve SR-1042 and apply the action?' }),
      ).toBeTruthy();
      fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
      fireEvent.click(screen.getByRole('button', { name: 'Reject' }));
      const dialog = (await screen.findByRole('heading', { name: 'Reject SR-1042?' })).closest(
        'dialog',
      ) as HTMLElement;
      expect(within(dialog).getByText(/Nothing will change\./)).toBeTruthy();
      fireEvent.change(within(dialog).getByLabelText('Reason (shown to the author)'), {
        target: { value: 'Not needed' },
      });
      call.mockResolvedValueOnce(ok(proposal({ status: 'reverted', decision: 'rejected' })));
      call.mockResolvedValueOnce(
        ok(
          proposal({
            status: 'reverted',
            decision: 'rejected',
            decidedBy: ME,
            decidedAt: '2026-11-12T01:00:00.000Z',
            decisionReason: 'Not needed',
            actions: [],
          }),
        ),
      );
      fireEvent.click(within(dialog).getByRole('button', { name: 'Reject' }));
      await expectToast('SR-1042 rejected. Nothing was changed.');
      expect(await screen.findByText(/Declined by you on/)).toBeTruthy();
      expect(screen.getAllByText('Declined').length).toBeGreaterThan(0);
      expect(screen.queryByText(/Reverted/)).toBeNull();
    });

    it('words a withdrawn proposal as not applied, and an approved one as applied', async () => {
      call.mockResolvedValue(
        ok(
          proposal({
            status: 'reverted',
            decision: 'withdrawn',
            requestedBy: ME,
            decidedBy: ME,
            decidedAt: '2026-11-12T01:00:00.000Z',
            decisionReason: 'Mistake',
            actions: [],
          }),
        ),
      );
      mount();
      expect(await screen.findByText(/Withdrawn by you on .* Nothing was changed/)).toBeTruthy();
      expect(screen.getByText('Withdrawn, not applied')).toBeTruthy();
      cleanup();
      call.mockResolvedValue(
        ok(
          proposal({
            status: 'approved',
            decision: 'approved',
            decidedBy: OTHER,
            decidedByName: 'Sara K.',
            decidedAt: '2026-11-12T01:00:00.000Z',
            actions: [],
          }),
        ),
      );
      mount();
      expect(await screen.findByText(/The action was applied\./)).toBeTruthy();
    });

    it('gives the author the withdraw action in its own words', async () => {
      call.mockResolvedValue(ok(proposal({ requestedBy: ME, actions: ['open', 'withdraw'] })));
      mount();
      expect(await screen.findByText(/You asked for this action\./)).toBeTruthy();
      expect(screen.getByRole('button', { name: 'Withdraw my request' })).toBeTruthy();
    });
  });
});
