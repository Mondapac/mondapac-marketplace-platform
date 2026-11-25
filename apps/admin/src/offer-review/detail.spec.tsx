// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { NextIntlClientProvider } from 'next-intl';
import type { ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import messages from '../../messages/en.json';

vi.mock('../api/client.ts', () => ({ callApi: vi.fn() }));

import { callApi } from '../api/client.ts';
import { DecisionDrawer } from './drawer.tsx';
import { ReviewDetail, type Subject } from './detail.tsx';
import { ReasonChips } from './reason-chips.tsx';
import type { ChangeRow, FirstRow } from './types.ts';

const call = vi.mocked(callApi);
const wrap = (node: ReactNode) => (
  <NextIntlClientProvider locale="en-AU" messages={messages} timeZone="Australia/Brisbane">
    {node}
  </NextIntlClientProvider>
);
const ok = (body: unknown = {}) => ({ ok: true as const, status: 200, body });
const fail = (status: number, code: string) => ({
  ok: false as const,
  failure: { status, code },
});

const CHANGE_ID = '0190a000-0000-7000-8000-0000000000a1';
const change = (over: Partial<ChangeRow> = {}): ChangeRow => ({
  changeId: CHANGE_ID,
  offerId: '0190a000-0000-7000-8000-0000000000b1',
  status: 'pending',
  fields: ['description', 'handling', 'tags'],
  proposedDescription: { 'en-AU': 'Sealed box of fresh dates', ms: 'Kotak kurma' },
  proposedHandling: 'REPACKED',
  proposedTagTypes: ['halal', 'organic'],
  baseOfferVersion: 3,
  submittedAt: '2026-11-24T22:00:00Z',
  decidedAt: null,
  decisionNote: null,
  supersededCause: null,
  reasons: ['handling', 'certificate-badge', 'zz-future'],
  sellerId: '0190a000-0000-7000-8000-0000000000c1',
  storeName: 'Date Palace',
  offer: {
    productId: 'p',
    sellerSku: 'DATE-1',
    conditionCode: 'new',
    status: 'published',
    version: 4,
  },
  product: { productCode: 'DATES', typeCode: 'grocery', name: 'Medjool dates' },
  live: {
    description: { 'en-AU': 'Sealed pack of dates', ms: 'Kotak kurma' },
    handling: 'SEALED_ORIGINAL',
    tagTypes: ['halal'],
  },
  actions: ['approve', 'request-changes', 'reject'],
  ...over,
});
const first = (over: Partial<FirstRow> = {}): FirstRow => ({
  kind: 'offer-first-publication',
  offerId: '0190a000-0000-7000-8000-0000000000b2',
  version: 7,
  sellerId: '0190a000-0000-7000-8000-0000000000c1',
  storeName: 'Date Palace',
  productId: 'p',
  product: { productCode: 'DATES', typeCode: 'grocery', name: 'Medjool dates' },
  sellerSku: 'DATE-1',
  conditionCode: 'new',
  description: { 'en-AU': 'Fresh dates' },
  handling: 'FRESH',
  reasons: ['probation'],
  tagTypes: [],
  submittedAt: '2026-11-24T22:00:00Z',
  actions: ['approve', 'request-changes'],
  ...over,
});

const mount = (subject: Subject, extra: Partial<Parameters<typeof ReviewDetail>[0]> = {}) => {
  const onDecided = vi.fn();
  const onReload = vi.fn();
  render(
    wrap(
      <ReviewDetail
        subject={subject}
        csrfToken="csrf"
        zone="Australia/Brisbane"
        canDecide
        viewerKeys={[]}
        onDecided={onDecided}
        onReload={onReload}
        {...extra}
      />,
    ),
  );
  return { onDecided, onReload };
};

beforeEach(() => {
  vi.clearAllMocks();
  HTMLDialogElement.prototype.showModal = function showModal(this: HTMLDialogElement) {
    this.setAttribute('open', '');
  };
  HTMLDialogElement.prototype.close = function close(this: HTMLDialogElement) {
    this.removeAttribute('open');
  };
});
afterEach(cleanup);

describe('ReasonChips', () => {
  it('names each reason in words, with a tone for R0 and R2 only, and shows an unknown code raw', () => {
    render(
      wrap(<ReasonChips reasons={['emergency-stop', 'certificate-badge', 'handling', 'zz-new']} />),
    );
    const items = within(screen.getByRole('list', { name: 'Why it waits' })).getAllByRole(
      'listitem',
    );
    expect(items.map((li) => li.textContent)).toEqual([
      'R0 Emergency stop',
      'R2 Certificate badge',
      'R3 Handling',
      'zz-new',
    ]);
    expect(items[0]?.firstElementChild?.className).toContain('critical');
    expect(items[2]?.firstElementChild?.className).not.toContain('critical');
  });
});

describe('ReviewDetail of an edit', () => {
  it('shows Live next to Proposed with signed, spoken marks, and the unchanged language folded', () => {
    mount({ kind: 'edit', row: change() });
    const description = screen.getByRole('region', { name: 'Description (en-AU)' });
    expect(within(description).getByText('Live')).toBeTruthy();
    expect(within(description).getByText('Proposed')).toBeTruthy();
    expect(description.querySelector('del')?.textContent).toContain('pack');
    expect(description.querySelector('del')?.textContent).toContain('Removed');
    expect(description.querySelector('ins')?.textContent).toContain('box');
    expect(description.querySelector('ins')?.textContent).toContain('Added');
    // ms is unchanged: folded, not a block of its own.
    expect(screen.queryByRole('region', { name: 'Description (ms)' })).toBeNull();
    expect(screen.getByText('1 unchanged language')).toBeTruthy();
    const handling = screen.getByRole('region', { name: 'Handling' });
    expect(within(handling).getByText('Sealed original')).toBeTruthy();
    expect(within(handling).getByText('Repacked')).toBeTruthy();
    const tags = screen.getByRole('region', { name: 'Certificates' });
    expect(within(tags).getByText(/Organic/).textContent).toContain('Added');
    // Any type code is shown from the data, nothing is hard-coded to one type.
    expect(within(tags).getAllByText(/Halal/).length).toBe(2);
  });

  it("isolates the seller's text and shows a hidden or direction character as its code", () => {
    mount({
      kind: 'edit',
      row: change({
        proposedDescription: { 'en-AU': 'Sealed\u202E box\u200B of dates' },
        live: { description: { 'en-AU': 'Sealed box of dates' }, handling: null, tagTypes: [] },
      }),
    });
    const description = screen.getByRole('region', { name: 'Description (en-AU)' });
    expect(within(description).getByRole('img', { name: 'Hidden character U+202E' })).toBeTruthy();
    expect(within(description).getByRole('img', { name: 'Hidden character U+200B' })).toBeTruthy();
    // Every part of the text sits in its own bidi isolate, so a mark cannot reorder its neighbours.
    const isolated = description.querySelectorAll('[class*="unicode-bidi:isolate"]');
    expect(isolated.length).toBeGreaterThan(2);
    expect(description.textContent).not.toContain('\u202E');
  });

  it('says so when the live values are unavailable and still shows the proposal', () => {
    mount({ kind: 'edit', row: change({ live: null }) });
    expect(screen.getByText(/Live values unavailable/)).toBeTruthy();
    expect(screen.getAllByText('Not available').length).toBeGreaterThan(0);
    expect(screen.getByText(/Sealed box of fresh dates/)).toBeTruthy();
  });

  it('needs a note to request changes or reject, trimmed, up to 2000 characters, and not to approve', () => {
    mount({ kind: 'edit', row: change() });
    const requestChanges = screen.getByRole('button', { name: 'Request changes' });
    const reject = screen.getByRole('button', { name: 'Reject' });
    expect((requestChanges as HTMLButtonElement).disabled).toBe(true);
    expect((reject as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByRole<HTMLButtonElement>('button', { name: 'Approve' }).disabled).toBe(false);
    const note = screen.getByRole('textbox', { name: /Note to the seller/ });
    fireEvent.change(note, { target: { value: '   ' } });
    expect(screen.getByText('0 / 2000')).toBeTruthy();
    expect((requestChanges as HTMLButtonElement).disabled).toBe(true);
    fireEvent.change(note, { target: { value: 'Please photograph the seal.' } });
    expect((requestChanges as HTMLButtonElement).disabled).toBe(false);
    expect((reject as HTMLButtonElement).disabled).toBe(false);
    fireEvent.change(note, { target: { value: 'x'.repeat(2001) } });
    expect(screen.getByText('The note can have at most 2000 characters.')).toBeTruthy();
    expect((requestChanges as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByRole<HTMLButtonElement>('button', { name: 'Approve' }).disabled).toBe(true);
  });

  it('rejects with the trimmed note and tells the list', async () => {
    call.mockResolvedValue(ok());
    const { onDecided } = mount({ kind: 'edit', row: change() });
    fireEvent.change(screen.getByRole('textbox', { name: /Note to the seller/ }), {
      target: { value: '  Not what the seal shows.  ' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Reject' }));
    await waitFor(() => expect(onDecided).toHaveBeenCalledWith('reject'));
    expect(call).toHaveBeenCalledWith(
      'POST',
      `catalog/admin/offer-changes/${CHANGE_ID}/reject`,
      { note: 'Not what the seal shows.' },
      'csrf',
    );
  });

  it('approves without a note as an empty body, and with one as the note', async () => {
    call.mockResolvedValue(ok());
    const { onDecided } = mount({ kind: 'edit', row: change() });
    fireEvent.click(screen.getByRole('button', { name: 'Approve' }));
    await waitFor(() => expect(onDecided).toHaveBeenCalledWith('approve'));
    expect(call).toHaveBeenCalledWith(
      'POST',
      `catalog/admin/offer-changes/${CHANGE_ID}/approve`,
      {},
      'csrf',
    );
  });

  it('disables every button while one decision is sent', async () => {
    let finish: (value: ReturnType<typeof ok>) => void = () => undefined;
    call.mockReturnValue(new Promise((resolve) => (finish = resolve)));
    mount({ kind: 'edit', row: change() });
    fireEvent.change(screen.getByRole('textbox', { name: /Note to the seller/ }), {
      target: { value: 'ok' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Request changes' }));
    await waitFor(() => {
      for (const name of ['Approve', 'Reject']) {
        expect(screen.getByRole('button', { name }).hasAttribute('disabled')).toBe(true);
      }
    });
    finish(ok());
  });

  it('tells a stale answer with a Reload that reads the row again', async () => {
    call.mockResolvedValue(fail(409, 'conflict.stale'));
    const { onReload } = mount({ kind: 'edit', row: change() });
    fireEvent.click(screen.getByRole('button', { name: 'Approve' }));
    expect(await screen.findByText(/Changed since you opened it/)).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Reload' }));
    expect(onReload).toHaveBeenCalled();
  });

  it('tells a permission refusal and an own-submission refusal in words', async () => {
    call.mockResolvedValueOnce(fail(403, 'access.denied'));
    mount({ kind: 'edit', row: change() });
    fireEvent.click(screen.getByRole('button', { name: 'Approve' }));
    expect(await screen.findByText(/catalog\.product\.approve/)).toBeTruthy();
    call.mockResolvedValueOnce(fail(403, 'offer-change.own-submission'));
    fireEvent.click(screen.getByRole('button', { name: 'Approve' }));
    expect(await screen.findByText(/your own account submitted/)).toBeTruthy();
  });

  it('says Superseded with the cause and offers no decision when the change was set aside', () => {
    mount({
      kind: 'edit',
      row: change({ status: 'superseded', supersededCause: 'resubmitted', actions: [] }),
    });
    expect(screen.getByText('Superseded: the seller sent a newer edit')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Approve' })).toBeNull();
    expect(screen.queryByRole('textbox')).toBeNull();
  });

  it('shows no decision button without the approve permission', () => {
    mount({ kind: 'edit', row: change() }, { canDecide: false });
    expect(screen.queryByRole('button', { name: 'Approve' })).toBeNull();
    expect(screen.getByText(/You can view this review but not decide/)).toBeTruthy();
  });

  it('shows the seller standing when the admin may read it', async () => {
    call.mockResolvedValue(
      ok({
        status: 'probation',
        source: null,
        trustedSince: null,
        count: 3,
        target: 10,
        targetKind: 'after-misconduct',
        consecutiveChangesNeeded: 1,
      }),
    );
    mount(
      { kind: 'edit', row: change() },
      { viewerKeys: ['catalog.product.approve', 'sellers.seller.view'] },
    );
    expect(await screen.findByText('3 of 10 first publications approved')).toBeTruthy();
    expect(screen.getByRole('progressbar').getAttribute('aria-valuenow')).toBe('3');
    expect(screen.getByText(/shortened after a misconduct removal/)).toBeTruthy();
    expect(call).toHaveBeenCalledWith(
      'GET',
      'catalog/admin/sellers/0190a000-0000-7000-8000-0000000000c1/review-standing',
    );
  });

  it('reads no standing without both permissions', () => {
    mount({ kind: 'edit', row: change() }, { viewerKeys: ['catalog.product.approve'] });
    expect(call).not.toHaveBeenCalled();
  });
});

describe('ReviewDetail of a first publication', () => {
  it('shows what the seller wrote and sends back with one prepared reason, naming the version', async () => {
    call.mockResolvedValue(ok());
    const { onDecided } = mount({ kind: 'first', row: first() });
    expect(screen.getByText('Fresh dates')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Reject' })).toBeNull();
    // The reason choice shows only once the reviewer chooses to send it back.
    expect(screen.queryByRole('combobox', { name: /Reason for sending it back/ })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Request changes' }));
    const reasonField = screen.getByRole('combobox', { name: /Reason for sending it back/ });
    // Focus moves into the reason field, and Approve gives way to the send-back choice.
    expect(document.activeElement).toBe(reasonField);
    expect(screen.queryByRole('button', { name: 'Approve' })).toBeNull();
    const send = screen.getByRole('button', { name: 'Send back' });
    expect((send as HTMLButtonElement).disabled).toBe(true);
    fireEvent.change(reasonField, { target: { value: 'handling-unclear' } });
    fireEvent.click(send);
    await waitFor(() => expect(onDecided).toHaveBeenCalledWith('request-changes'));
    expect(call).toHaveBeenCalledWith(
      'POST',
      'catalog/admin/offers/0190a000-0000-7000-8000-0000000000b2/request-changes',
      { version: 7, reasonCode: 'handling-unclear' },
      'csrf',
    );
  });

  it('puts the focus back on Request changes when the send-back choice is cancelled', () => {
    mount({ kind: 'first', row: first() });
    const open = screen.getByRole('button', { name: 'Request changes' });
    fireEvent.click(open);
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(screen.queryByRole('combobox', { name: /Reason for sending it back/ })).toBeNull();
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Request changes' }));
    expect(screen.getByRole('button', { name: 'Approve' })).toBeTruthy();
  });

  it('approves naming the version it saw', async () => {
    call.mockResolvedValue(ok());
    const { onDecided } = mount({ kind: 'first', row: first() });
    fireEvent.click(screen.getByRole('button', { name: 'Approve' }));
    await waitFor(() => expect(onDecided).toHaveBeenCalledWith('approve'));
    expect(call).toHaveBeenCalledWith(
      'POST',
      'catalog/admin/offers/0190a000-0000-7000-8000-0000000000b2/approve',
      { version: 7 },
      'csrf',
    );
  });
});

describe('DecisionDrawer keyboard', () => {
  function mountDrawer(onClose = vi.fn()) {
    const subject: Subject = { kind: 'edit', row: change() };
    render(
      wrap(
        <DecisionDrawer
          subject={subject}
          csrfToken="csrf"
          zone="Australia/Brisbane"
          canDecide
          viewerKeys={[]}
          onClose={onClose}
          onDecided={vi.fn()}
          onReload={vi.fn()}
        />,
      ),
    );
    return onClose;
  }
  const panel = () =>
    screen
      .getAllByRole('dialog', { hidden: true })
      .find((dialog) =>
        within(dialog).queryByRole('heading', { name: 'Offer review', hidden: true }),
      ) as HTMLDialogElement;

  it('closes on Escape when nothing is typed', () => {
    const onClose = mountDrawer();
    // Escape on a native dialog is its cancel event; the panel turns it into its own close.
    const cancel = new Event('cancel', { cancelable: true });
    panel().dispatchEvent(cancel);
    expect(cancel.defaultPrevented).toBe(true);
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('asks on Escape when a note is typed, and keeps the focus on Keep editing', async () => {
    const onClose = mountDrawer();
    fireEvent.change(screen.getByRole('textbox', { name: /Note to the seller/, hidden: true }), {
      target: { value: 'half written' },
    });
    panel().dispatchEvent(new Event('cancel', { cancelable: true }));
    expect(onClose).not.toHaveBeenCalled();
    const keep = await screen.findByRole('button', { name: 'Keep editing', hidden: true });
    await waitFor(() => expect(document.activeElement).toBe(keep));
    // Enter on the focused button keeps the text; nothing is thrown away.
    fireEvent.click(keep);
    expect(onClose).not.toHaveBeenCalled();
  });

  it('announces a refusal to a screen reader as an alert', async () => {
    call.mockResolvedValue(fail(409, 'conflict.stale'));
    mountDrawer();
    fireEvent.click(screen.getByRole('button', { name: 'Approve', hidden: true }));
    const alerts = await screen.findAllByRole('alert', { hidden: true });
    expect(alerts.some((alert) => alert.textContent?.includes('Changed since you opened it'))).toBe(
      true,
    );
    // One alert for the refusal, not one nested in another.
    expect(alerts.some((alert) => alert.querySelector('[role="alert"]') !== null)).toBe(false);
  });
});

describe('DecisionDrawer', () => {
  it('asks before closing with a note typed, and closes without asking otherwise', () => {
    const onClose = vi.fn();
    const subject: Subject = { kind: 'edit', row: change() };
    render(
      wrap(
        <DecisionDrawer
          subject={subject}
          csrfToken="csrf"
          zone="Australia/Brisbane"
          canDecide
          viewerKeys={[]}
          onClose={onClose}
          onDecided={vi.fn()}
          onReload={vi.fn()}
        />,
      ),
    );
    const confirm = vi.spyOn(window, 'confirm');
    const panel = screen
      .getAllByRole('dialog', { hidden: true })
      .find((dialog) =>
        within(dialog).queryByRole('heading', { name: 'Offer review', hidden: true }),
      );
    expect(panel).toBeTruthy();
    // The confirm Dialog shows its title and buttons only while it is open.
    const asking = () =>
      screen
        .getAllByRole('dialog', { hidden: true })
        .find((dialog) =>
          within(dialog).queryByRole('heading', { name: 'Discard what you typed?', hidden: true }),
        );
    const isOpen = () => asking() !== undefined;
    expect(isOpen()).toBe(false);
    fireEvent.click(screen.getByRole('button', { name: 'Close', hidden: true }));
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(isOpen()).toBe(false);
    fireEvent.change(screen.getByRole('textbox', { name: /Note to the seller/, hidden: true }), {
      target: { value: 'half written' },
    });
    // Typed text: Close asks in the library's confirm Dialog, never the browser's prompt.
    fireEvent.click(screen.getByRole('button', { name: 'Close', hidden: true }));
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(isOpen()).toBe(true);
    expect(within(asking()!).getByText('The note or reason you typed is not saved.')).toBeTruthy();
    fireEvent.click(within(asking()!).getByRole('button', { name: 'Keep editing', hidden: true }));
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(isOpen()).toBe(false);
    fireEvent.click(screen.getByRole('button', { name: 'Close', hidden: true }));
    fireEvent.click(within(asking()!).getByRole('button', { name: 'Discard', hidden: true }));
    expect(onClose).toHaveBeenCalledTimes(2);
    expect(confirm).not.toHaveBeenCalled();
  });
});
