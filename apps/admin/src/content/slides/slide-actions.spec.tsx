// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { NextIntlClientProvider } from 'next-intl';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import messages from '../../../messages/en.json';

const router = { replace: vi.fn(), push: vi.fn(), refresh: vi.fn() };
vi.mock('next/navigation', () => ({ useRouter: () => router }));
vi.mock('../../api/client.ts', () => ({ callApi: vi.fn() }));

import { callApi } from '../../api/client.ts';
import { actionsFor } from './slide-actions.tsx';
import { SlideEditor } from './slide-editor.tsx';
import { CATEGORY, ID, detail, version } from './test-data.ts';
import type { SlideDetail, SlideGates, SlidePlacement } from './slide-types.ts';

const call = vi.mocked(callApi);
const ZONE = 'Australia/Brisbane';

interface Keys {
  readonly canEdit?: boolean;
  readonly canPause?: boolean;
  readonly canPublish?: boolean;
}
function mount(slide: SlideDetail, keys: Keys = { canEdit: true }, startReview = false) {
  return render(
    <NextIntlClientProvider locale="en-AU" messages={messages}>
      <SlideEditor
        slide={slide}
        canEdit={keys.canEdit ?? false}
        canPause={keys.canPause ?? false}
        canPublish={keys.canPublish ?? false}
        startReview={startReview}
        csrfToken="csrf-1"
        zone={ZONE}
      />
    </NextIntlClientProvider>,
  );
}
const ok = (body: SlideDetail) => ({ ok: true as const, status: 200, body });
const refused = (code: string, status = 409, fields?: { path: string; code: string }[]) => ({
  ok: false as const,
  failure: { status, code, ...(fields === undefined ? {} : { details: { fields } }) },
});

const waiting = () => detail({ status: 'pending', pending: true });
const live = () => detail({ status: 'live', draft: null, hasDraft: false });
const scheduled = () => detail({ status: 'scheduled', draft: null, hasDraft: false });
const paused = () => detail({ status: 'paused', draft: null, hasDraft: false });
const archived = () => detail({ status: 'archived', draft: null, live: null, hasDraft: false });

const sendButton = () => screen.queryByRole('button', { name: 'Send for approval' });
const reviewButton = () => screen.queryByRole('button', { name: 'Review and approve' });
const moreButton = () => screen.queryByRole('button', { name: 'More actions' });
function menuItems(): string[] {
  const more = moreButton();
  if (more === null) return [];
  fireEvent.click(more);
  const names = screen.getAllByRole('menuitem').map((item) => item.textContent ?? '');
  fireEvent.click(more);
  return names;
}
const choose = (name: string) => {
  fireEvent.click(screen.getByRole('button', { name: 'More actions' }));
  fireEvent.click(screen.getByRole('menuitem', { name }));
};

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

describe('what the header offers, by key and by state (pure)', () => {
  const gates = (over: Partial<SlideGates>): SlideGates => ({
    edit: false,
    pause: false,
    publish: false,
    ...over,
  });
  it('gives nothing without a key', () => {
    for (const slide of [detail(), waiting(), live(), paused(), archived()]) {
      expect(Object.values(actionsFor(slide, gates({}))).every((on) => !on)).toBe(true);
    }
  });
  it('lets each key switch on only its own commands', () => {
    expect(actionsFor(detail(), gates({ edit: true }))).toEqual({
      submit: true,
      review: false,
      pause: false,
      resume: false,
      copy: true,
      archive: true,
    });
    expect(actionsFor(live(), gates({ pause: true }))).toMatchObject({
      pause: true,
      submit: false,
      resume: false,
      archive: false,
    });
    expect(actionsFor(paused(), gates({ publish: true }))).toMatchObject({
      resume: true,
      review: false,
      pause: false,
    });
    expect(actionsFor(waiting(), gates({ publish: true }))).toMatchObject({
      review: true,
      submit: false,
    });
  });
  it('offers Pause on live and scheduled slides only', () => {
    const g = gates({ pause: true });
    expect(actionsFor(live(), g).pause).toBe(true);
    expect(actionsFor(scheduled(), g).pause).toBe(true);
    expect(actionsFor(paused(), g).pause).toBe(false);
    expect(actionsFor(waiting(), g).pause).toBe(false);
    expect(actionsFor(archived(), g).pause).toBe(false);
  });
  it('offers nothing to submit on a slide that is archived, waiting or has no draft', () => {
    const g = gates({ edit: true });
    expect(actionsFor(archived(), g)).toMatchObject({ submit: false, archive: false, copy: true });
    expect(actionsFor(waiting(), g).submit).toBe(false);
    expect(actionsFor(live(), g).submit).toBe(false);
  });
});

describe('permission gates in the editor header and More menu', () => {
  it('storefront.slide.read only: no command at all, not even disabled', () => {
    mount(detail(), {});
    expect(sendButton()).toBeNull();
    expect(reviewButton()).toBeNull();
    expect(moreButton()).toBeNull();
    expect(document.querySelectorAll('dialog')).toHaveLength(0);
  });

  it('storefront.slide.edit: Send for approval, Copy and Archive; no Pause, Resume or Review', () => {
    mount(detail(), { canEdit: true });
    expect(sendButton()).not.toBeNull();
    expect(reviewButton()).toBeNull();
    expect(menuItems()).toEqual(['Copy to another Market…', 'Archive']);
  });

  it('storefront.slide.edit is what Send for approval, Copy, Archive and Restore need, not pause or publish', () => {
    mount(detail(), { canPause: true, canPublish: true });
    expect(sendButton()).toBeNull();
    expect(menuItems()).not.toContain('Archive');
    expect(menuItems()).not.toContain('Copy to another Market…');
  });

  it('storefront.slide.pause: Pause on a live slide, and only that', () => {
    mount(live(), { canPause: true });
    expect(sendButton()).toBeNull();
    expect(menuItems()).toEqual(['Pause']);
    cleanup();
    mount(live(), { canEdit: true, canPublish: true });
    expect(menuItems()).not.toContain('Pause');
  });

  it('storefront.slide.publish: Review on a waiting slide and Resume… on a paused one', () => {
    mount(waiting(), { canPublish: true });
    expect(reviewButton()).not.toBeNull();
    expect(moreButton()).toBeNull();
    cleanup();
    mount(waiting(), { canEdit: true, canPause: true });
    expect(reviewButton()).toBeNull();
    cleanup();
    mount(paused(), { canPublish: true });
    expect(menuItems()).toEqual(['Resume…']);
    cleanup();
    mount(paused(), { canEdit: true, canPause: true });
    expect(menuItems()).not.toContain('Resume…');
  });

  it('shows Review beside Send for approval only for the one who may approve a waiting slide', () => {
    mount(detail(), { canEdit: true, canPublish: true });
    expect(reviewButton()).toBeNull();
    expect(sendButton()).not.toBeNull();
  });

  it('has no Send back control anywhere: the API has no such command', () => {
    mount(waiting(), { canEdit: true, canPause: true, canPublish: true });
    expect(screen.queryByText(/send back/i)).toBeNull();
    expect(menuItems().join()).not.toMatch(/send back/i);
  });

  it('puts a dialog in the page only for a holder of its key', () => {
    const dialogs = (slide: SlideDetail, keys: Keys) => {
      cleanup();
      mount(slide, keys);
      return document.querySelectorAll('dialog').length;
    };
    // A live slide: Pause, Archive and Copy.
    expect(dialogs(live(), { canEdit: true, canPause: true, canPublish: true })).toBe(3);
    expect(dialogs(live(), { canEdit: true })).toBe(2);
    expect(dialogs(live(), { canPause: true })).toBe(1);
    expect(dialogs(live(), { canPublish: true })).toBe(0);
    expect(dialogs(live(), {})).toBe(0);
    // A slide that is waiting: Approve needs publish.
    expect(dialogs(waiting(), { canPublish: true })).toBe(1);
    expect(dialogs(waiting(), { canEdit: true, canPause: true })).toBe(2);
    // A paused slide: Resume needs publish.
    expect(dialogs(paused(), { canPublish: true })).toBe(1);
    expect(dialogs(paused(), { canEdit: true, canPause: true })).toBe(2);
  });

  it('shows no command on an archived slide but Copy', () => {
    mount(archived(), { canEdit: true, canPause: true, canPublish: true });
    expect(sendButton()).toBeNull();
    expect(menuItems()).toEqual(['Copy to another Market…']);
  });
});

describe('the banner of a slide that is waiting', () => {
  it('says it is waiting for a platform admin, to everyone who can read it', () => {
    mount(waiting(), {});
    expect(screen.getByText('Waiting for a platform admin to approve')).toBeTruthy();
    expect(screen.getByText(/You can still edit; a new edit withdraws the request/)).toBeTruthy();
  });

  it('is absent when nothing was sent', () => {
    mount(detail(), { canEdit: true });
    expect(screen.queryByText('Waiting for a platform admin to approve')).toBeNull();
  });
});

describe('Send for approval', () => {
  it('posts the submit with the token and then shows the banner and says what happened', async () => {
    call.mockResolvedValue(ok(waiting()));
    mount(detail(), { canEdit: true });
    fireEvent.click(sendButton()!);
    await waitFor(() =>
      expect(call).toHaveBeenCalledWith(
        'POST',
        `storefront/admin/slides/${ID}/submit`,
        {},
        'csrf-1',
      ),
    );
    expect(await screen.findByText(/Sent “Diwali sweets week” for approval/)).toBeTruthy();
    expect(screen.getByText('Waiting for a platform admin to approve')).toBeTruthy();
    // Once it is waiting there is nothing more to send.
    expect(sendButton()).toBeNull();
  });

  it('cannot be pressed twice at once', async () => {
    let finish: (value: ReturnType<typeof ok>) => void = () => undefined;
    call.mockReturnValue(new Promise((resolve) => (finish = resolve)));
    mount(detail(), { canEdit: true });
    fireEvent.click(sendButton()!);
    fireEvent.click(sendButton()!);
    expect(call).toHaveBeenCalledTimes(1);
    finish(ok(waiting()));
    await screen.findByText(/Sent “Diwali sweets week” for approval/);
  });

  it('waits for unsaved changes to be saved, with the reason on the button', () => {
    mount(detail(), { canEdit: true });
    const button = sendButton() as HTMLButtonElement;
    expect(button.disabled).toBe(false);
    fireEvent.change(screen.getByLabelText('Headline'), { target: { value: 'Another headline' } });
    expect(button.disabled).toBe(true);
    expect(button.getAttribute('title')).toBe('Save your changes to the draft first');
  });

  it.each([
    ['storefront.slide-no-draft', /no draft to send or approve/],
    ['storefront.slide-ended', /window has already ended/],
    ['storefront.slide-archived', /archived and can no longer be changed/],
  ])('says why a %s refusal happened and keeps the button', async (code, text) => {
    call.mockResolvedValue(refused(code));
    mount(detail(), { canEdit: true });
    fireEvent.click(sendButton()!);
    expect((await screen.findByRole('alert')).textContent).toMatch(text);
    expect(sendButton()).not.toBeNull();
  });

  it('says so when the connection is lost, and signs out a rejected session', async () => {
    call.mockResolvedValue(refused('network', 0));
    mount(detail(), { canEdit: true });
    fireEvent.click(sendButton()!);
    expect((await screen.findByRole('alert')).textContent).toContain('No connection');
    call.mockResolvedValue(refused('access.unauthenticated', 401));
    fireEvent.click(sendButton()!);
    await waitFor(() => expect(router.replace).toHaveBeenCalledWith('/session-ended'));
  });
});

describe('Approve dialog (storefront.slide.publish)', () => {
  const open = () => fireEvent.click(reviewButton()!);
  const dialog = () => screen.getByRole('dialog');

  it('opens at once for the Review link, named by its heading', () => {
    mount(waiting(), { canPublish: true }, true);
    expect(screen.getByRole('dialog', { name: 'Approve “Diwali sweets week”' })).toBeTruthy();
  });

  it('does not open by itself without the key, even for the Review link', () => {
    mount(waiting(), { canEdit: true }, true);
    expect(document.querySelectorAll('dialog[open]')).toHaveLength(0);
  });

  it('shows the preview, the draft version, what changes and what the system checks', () => {
    mount(waiting(), { canPublish: true });
    open();
    const box = within(dialog());
    expect(box.getByText(/Draft version 3, saved/)).toBeTruthy();
    expect(box.getByRole('img', { name: /Preview of the slide/ })).toBeTruthy();
    expect(box.getByRole('heading', { name: 'What changes for buyers' })).toBeTruthy();
    expect(box.getByRole('heading', { name: 'Checked by the system' })).toBeTruthy();
    expect(box.getByText(/the system checks that every link/)).toBeTruthy();
    // The same text as the live version: nothing to list but the confirmation box.
    expect(box.getByText('Nothing differs from the live version.')).toBeTruthy();
    expect(box.getByRole('checkbox', { name: /I checked the text and image/ })).toBeTruthy();
    expect(box.getByRole('button', { name: 'Approve' })).toBeTruthy();
    expect(box.getByRole('button', { name: 'Cancel' })).toBeTruthy();
  });

  it('lists what changed against the live version, at most 8 lines, then “and n more”', () => {
    const placements: SlidePlacement[] = [
      'home.mid',
      'category.top',
      'cart.below-lines',
      'landing.top',
      'product.below-details',
    ].map((position) => ({
      position,
      scope: 'all',
      scopeId: null,
      includeSubcategories: false,
      sortOrder: 0,
      autoplay: false,
    }));
    const draft = version({
      versionNo: 3,
      internalName: 'Renamed',
      pinned: true,
      sponsored: true,
      content: {
        title: 'New headline',
        body: 'New text',
        ctaLabel: 'Go',
        textPosition: 'start',
        textTone: 'light',
        link: { type: 'product', id: CATEGORY },
      },
      placements: [...placements],
    });
    mount(detail({ status: 'pending', pending: true, draft }), { canPublish: true });
    open();
    const items = within(dialog()).getAllByRole('listitem');
    expect(items).toHaveLength(8);
    expect(items[0]?.textContent).toBe('Internal name is now “Renamed”');
    expect(within(dialog()).getByText('and 6 more changes')).toBeTruthy();
  });

  it('describes a slide that was never live by its first lines', () => {
    mount(detail({ status: 'pending', pending: true, live: null }), { canPublish: true });
    open();
    expect(within(dialog()).getByText('A new slide that buyers have not seen before')).toBeTruthy();
    expect(within(dialog()).getByText(/Added to Home · top/)).toBeTruthy();
  });

  it('asks for the confirmation box before it posts anything', () => {
    mount(waiting(), { canPublish: true });
    open();
    fireEvent.click(within(dialog()).getByRole('button', { name: 'Approve' }));
    expect(within(dialog()).getByText('Tick the box to confirm before you approve.')).toBeTruthy();
    expect(call).not.toHaveBeenCalled();
  });

  it('approves the version it showed, then closes and shows the new state', async () => {
    call.mockResolvedValue(ok(live()));
    mount(waiting(), { canPublish: true });
    open();
    fireEvent.click(within(dialog()).getByRole('checkbox'));
    fireEvent.click(within(dialog()).getByRole('button', { name: 'Approve' }));
    await waitFor(() =>
      expect(call).toHaveBeenCalledWith(
        'POST',
        `storefront/admin/slides/${ID}/approve`,
        { versionNo: 3 },
        'csrf-1',
      ),
    );
    expect(await screen.findByText(/Approved “Diwali sweets week”/)).toBeTruthy();
    expect(document.querySelectorAll('dialog[open]')).toHaveLength(0);
    expect(screen.queryByText('Waiting for a platform admin to approve')).toBeNull();
  });

  it('lists what the system found when the approval is refused, and approves nothing', async () => {
    call.mockResolvedValue(
      refused('storefront.slide-link-invalid', 409, [
        { path: 'content.link', code: 'not-found' },
        { path: 'placements[0].scopeId', code: 'unverifiable' },
      ]),
    );
    const slide = detail({
      status: 'pending',
      pending: true,
      draft: version({
        versionNo: 3,
        placements: [
          {
            position: 'category.top',
            scope: 'category',
            scopeId: CATEGORY,
            includeSubcategories: false,
            sortOrder: 0,
            autoplay: false,
          },
        ],
      }),
    });
    mount(slide, { canPublish: true });
    open();
    fireEvent.click(within(dialog()).getByRole('checkbox'));
    fireEvent.click(within(dialog()).getByRole('button', { name: 'Approve' }));
    const alert = await within(dialog()).findByRole('alert');
    expect(alert.textContent).toContain('nothing was approved');
    expect(alert.textContent).toContain('The link no longer opens something that is live');
    expect(alert.textContent).toContain('Category · above list, One category: the chosen');
    // Still open, so the admin can read it.
    expect(dialog()).toBeTruthy();
  });

  it('names the full position when the API says a position is full', async () => {
    call.mockResolvedValue(
      refused('storefront.slide-position-full', 409, [
        { path: 'placements[0].position', code: 'full' },
      ]),
    );
    mount(waiting(), { canPublish: true });
    open();
    fireEvent.click(within(dialog()).getByRole('checkbox'));
    fireEvent.click(within(dialog()).getByRole('button', { name: 'Approve' }));
    const alert = await within(dialog()).findByRole('alert');
    expect(alert.textContent).toContain('Home · top already has its most live slides');
  });

  it('closes and reads the page again when the editor changed the draft meanwhile', async () => {
    call.mockResolvedValue(refused('storefront.slide-draft-changed'));
    mount(waiting(), { canPublish: true });
    open();
    fireEvent.click(within(dialog()).getByRole('checkbox'));
    fireEvent.click(within(dialog()).getByRole('button', { name: 'Approve' }));
    expect((await within(dialog()).findByRole('alert')).textContent).toContain(
      'The editor changed the draft',
    );
    // Only Close is left: approving the old version again would be refused the same way.
    expect(within(dialog()).queryByRole('button', { name: 'Approve' })).toBeNull();
    fireEvent.click(within(dialog()).getByRole('button', { name: 'Close' }));
    expect(router.refresh).toHaveBeenCalled();
  });

  it('closes on Escape without posting, and starts clean when it is opened again', () => {
    mount(waiting(), { canPublish: true });
    open();
    fireEvent.click(within(dialog()).getByRole('checkbox'));
    fireEvent(dialog(), new Event('cancel', { cancelable: true }));
    expect(document.querySelectorAll('dialog[open]')).toHaveLength(0);
    expect(call).not.toHaveBeenCalled();
    open();
    expect(within(dialog()).getByRole<HTMLInputElement>('checkbox').checked).toBe(false);
  });
});

describe('Pause (storefront.slide.pause)', () => {
  it('asks first, says buyers stop within a minute and that resuming needs a platform admin', async () => {
    call.mockResolvedValue(ok(paused()));
    mount(live(), { canPause: true });
    choose('Pause');
    const box = within(screen.getByRole('dialog', { name: 'Pause “Diwali sweets week”?' }));
    expect(
      box.getByText(/Buyers stop seeing this slide within a minute, on every position/),
    ).toBeTruthy();
    expect(box.getByText('Turning it back on needs a platform admin’s approval.')).toBeTruthy();
    expect(call).not.toHaveBeenCalled();
    fireEvent.click(box.getByRole('button', { name: 'Pause now' }));
    await waitFor(() =>
      expect(call).toHaveBeenCalledWith(
        'POST',
        `storefront/admin/slides/${ID}/pause`,
        {},
        'csrf-1',
      ),
    );
    expect(await screen.findByText(/Paused “Diwali sweets week”/)).toBeTruthy();
    expect(document.querySelectorAll('dialog[open]')).toHaveLength(0);
    // Paused now: a holder of the pause key has nothing more to do here.
    expect(moreButton()).toBeNull();
  });

  it('keeps the slide as it is on Cancel and on Escape', () => {
    mount(live(), { canPause: true });
    choose('Pause');
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(document.querySelectorAll('dialog[open]')).toHaveLength(0);
    choose('Pause');
    fireEvent(screen.getByRole('dialog'), new Event('cancel', { cancelable: true }));
    expect(document.querySelectorAll('dialog[open]')).toHaveLength(0);
    expect(call).not.toHaveBeenCalled();
  });

  it('says so when it was not live any more, closes, and reads the page again', async () => {
    call.mockResolvedValue(refused('storefront.slide-not-live'));
    mount(live(), { canPause: true });
    choose('Pause');
    fireEvent.click(screen.getByRole('button', { name: 'Pause now' }));
    expect((await screen.findByRole('alert')).textContent).toContain('not live');
    fireEvent.click(screen.getByRole('button', { name: 'Close' }));
    expect(router.refresh).toHaveBeenCalled();
  });
});

describe('Resume… (storefront.slide.publish)', () => {
  it('asks first, then resumes', async () => {
    call.mockResolvedValue(ok(live()));
    mount(paused(), { canPublish: true });
    choose('Resume…');
    const box = within(screen.getByRole('dialog', { name: 'Resume “Diwali sweets week”?' }));
    fireEvent.click(box.getByRole('button', { name: 'Resume now' }));
    await waitFor(() =>
      expect(call).toHaveBeenCalledWith(
        'POST',
        `storefront/admin/slides/${ID}/resume`,
        {},
        'csrf-1',
      ),
    );
    expect(await screen.findByText(/Resumed “Diwali sweets week”/)).toBeTruthy();
  });

  it('names the position that is full', async () => {
    call.mockResolvedValue(
      refused('storefront.slide-position-full', 409, [
        { path: 'placements[0].position', code: 'full' },
      ]),
    );
    mount(paused(), { canPublish: true });
    choose('Resume…');
    fireEvent.click(screen.getByRole('button', { name: 'Resume now' }));
    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toContain('Home · top already has its most live slides');
  });
});

describe('Archive (storefront.slide.edit)', () => {
  it('asks first, then archives and shows the slide as archived', async () => {
    call.mockResolvedValue(ok(archived()));
    mount(detail(), { canEdit: true });
    choose('Archive');
    const box = within(screen.getByRole('dialog', { name: 'Archive “Diwali sweets week”?' }));
    expect(box.getByText(/never shown again/)).toBeTruthy();
    expect(call).not.toHaveBeenCalled();
    fireEvent.click(box.getByRole('button', { name: 'Archive' }));
    await waitFor(() =>
      expect(call).toHaveBeenCalledWith(
        'POST',
        `storefront/admin/slides/${ID}/archive`,
        {},
        'csrf-1',
      ),
    );
    expect(await screen.findByText(/Archived “Diwali sweets week”/)).toBeTruthy();
    expect(sendButton()).toBeNull();
    expect(menuItems()).toEqual(['Copy to another Market…']);
  });
});

describe('Copy to another Market… (storefront.slide.edit)', () => {
  const pack = {
    kind: 'promotion',
    internalName: 'Diwali sweets week',
    content: { title: 'Diwali sweets, delivered' },
    startsAt: '2026-10-26T14:00:00Z',
    endsAt: '2026-11-03T13:59:00Z',
    pinned: false,
    sponsored: false,
    placements: [{ position: 'home.hero', scope: 'all' }],
  };
  const reads = () => ({ ok: true as const, status: 200, body: pack });

  it('reads the package, says what is kept and left out, and says the panel cannot create it', async () => {
    call.mockResolvedValue(reads());
    mount(detail(), { canEdit: true });
    choose('Copy to another Market…');
    expect(call).toHaveBeenCalledWith('GET', `storefront/admin/slides/${ID}/copy`);
    const box = within(
      screen.getByRole('dialog', { name: 'Copy “Diwali sweets week” to another Market' }),
    );
    expect(box.getByText(/cannot create the copy in another Market/)).toBeTruthy();
    expect(
      await box.findByText(/Kept: the text, the picture, the dates, the flags and 1 position/),
    ).toBeTruthy();
    expect(box.getByText(/Left out: what the slide opens and the button text/)).toBeTruthy();
    expect(box.getByText(/It starts as a draft there/)).toBeTruthy();
    // No Market picker: the panel works in one Market.
    expect(box.queryByRole('combobox')).toBeNull();
  });

  it('copies the package as text', async () => {
    call.mockResolvedValue(reads());
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });
    mount(detail(), { canEdit: true });
    choose('Copy to another Market…');
    await screen.findByText(/Kept:/);
    fireEvent.click(screen.getByRole('button', { name: 'Copy package' }));
    await waitFor(() => expect(writeText).toHaveBeenCalledTimes(1));
    expect(JSON.parse(writeText.mock.calls[0]![0] as string)).toEqual(pack);
    expect(await screen.findByText('Package copied.')).toBeTruthy();
  });

  it('points to the file when the clipboard is not available', async () => {
    call.mockResolvedValue(reads());
    Object.defineProperty(navigator, 'clipboard', {
      value: { writeText: vi.fn().mockRejectedValue(new Error('denied')) },
      configurable: true,
    });
    mount(detail(), { canEdit: true });
    choose('Copy to another Market…');
    await screen.findByText(/Kept:/);
    fireEvent.click(screen.getByRole('button', { name: 'Copy package' }));
    expect(await screen.findByText(/Use Download file instead/)).toBeTruthy();
  });

  it('offers a file download', async () => {
    call.mockResolvedValue(reads());
    const create = vi.fn(() => 'blob:x');
    Object.assign(URL, { createObjectURL: create, revokeObjectURL: vi.fn() });
    const click = vi
      .spyOn(HTMLAnchorElement.prototype, 'click')
      .mockImplementation(() => undefined);
    mount(detail(), { canEdit: true });
    choose('Copy to another Market…');
    await screen.findByText(/Kept:/);
    fireEvent.click(screen.getByRole('button', { name: 'Download file' }));
    expect(create).toHaveBeenCalledTimes(1);
    expect(click).toHaveBeenCalledTimes(1);
    expect(await screen.findByText('File downloaded.')).toBeTruthy();
    click.mockRestore();
  });

  it('shows a retry when the package cannot be read, with the buttons off', async () => {
    call.mockResolvedValueOnce(refused('unknown', 500)).mockResolvedValueOnce(reads());
    mount(detail(), { canEdit: true });
    choose('Copy to another Market…');
    expect((await screen.findByRole('alert')).textContent).toContain('could not be prepared');
    expect(screen.getByRole<HTMLButtonElement>('button', { name: 'Copy package' }).disabled).toBe(
      true,
    );
    fireEvent.click(screen.getByRole('button', { name: 'Try again' }));
    expect(await screen.findByText(/Kept:/)).toBeTruthy();
  });
});
