// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { NextIntlClientProvider } from 'next-intl';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import messages from '../../../messages/en.json';

vi.mock('../../api/client.ts', () => ({ callApi: vi.fn() }));

import { callApi } from '../../api/client.ts';
import { CATEGORY, IMG, PRODUCT, REVISION, read } from './fixtures.ts';
import type { RevisionImage, RevisionRead } from './types.ts';
import { VersionReview } from './version-review.tsx';

const call = vi.mocked(callApi);
const assign = vi.fn();
const reload = vi.fn();
const images: RevisionImage[] = [
  { imageId: IMG(1), position: 1, state: 'clean', width: 800, height: 800 },
  { imageId: IMG(3), position: 2, state: 'clean', width: 800, height: 800 },
];

function mount(
  over: Partial<RevisionRead> = {},
  canDecide = true,
  nextHref: string | null = '/next',
  photos: readonly RevisionImage[] | null = images,
  canTakeDown = canDecide,
) {
  return render(
    <NextIntlClientProvider locale="en-AU" messages={messages} timeZone="UTC">
      <VersionReview
        read={{ ...read, ...over }}
        images={photos}
        categoryNames={{ [CATEGORY(1)]: 'Oils', [CATEGORY(2)]: 'Olive oils' }}
        canDecide={canDecide}
        canTakeDown={canTakeDown}
        csrfToken="csrf-1"
        nextHref={nextHref}
      />
    </NextIntlClientProvider>,
  );
}
const fail = (status: number, code: string) =>
  call.mockResolvedValueOnce({ ok: false, failure: { status, code } });
const ok = () => call.mockResolvedValueOnce({ ok: true, status: 200, body: {} });
const base = `catalog/admin/products/${PRODUCT}/revisions/${REVISION}`;
/** The open dialog with this title (closed ones stay in the page, empty). */
const dialogTitled = (title: string) =>
  within(screen.getByRole('heading', { name: title, hidden: true }).closest('dialog')!);

beforeEach(() => {
  vi.clearAllMocks();
  // jsdom has no showModal; the dialog only needs to render its content when open.
  HTMLDialogElement.prototype.showModal = vi.fn();
  HTMLDialogElement.prototype.close = vi.fn();
  Object.defineProperty(window, 'location', { value: { assign, reload }, writable: true });
});
afterEach(cleanup);

describe('VersionReview content', () => {
  it('shows the summary, the duplicate warning and what changed in words and signs', () => {
    mount();
    expect(screen.getByRole('heading', { level: 1, name: 'Extra virgin olive oil' })).toBeTruthy();
    expect(screen.getByText('Cedar Lane')).toBeTruthy();
    expect(screen.getByText('Revision 2')).toBeTruthy();
    expect(screen.getByText('A GTIN of this version is on another product.')).toBeTruthy();
    // The old name is struck with −, the new one underlined with +, and both say so to a reader.
    expect(screen.getByText('Olive oil').closest('.line-through')).toBeTruthy();
    expect(
      screen.getByText('Extra virgin olive oil', { selector: '.underline *, .underline' }),
    ).toBeTruthy();
    expect(screen.getAllByText('Removed:').length).toBeGreaterThan(0);
    // An unchanged locale is folded.
    expect(screen.getByText('ar: unchanged').closest('details')).toBeTruthy();
    // Categories by name, with the change in words.
    expect(screen.getByText('Olive oils')).toBeTruthy();
    expect(screen.getByText('Oils').closest('.line-through')).toBeTruthy();
    expect(screen.getByText('food-standard')).toBeTruthy();
    // Variants and the changed attribute.
    expect(screen.getByText('3 litre')).toBeTruthy();
    expect(screen.getByText('organic')).toBeTruthy();
    // The photo of this version that was not published is new; one published photo is removed.
    expect(screen.getByText('Photo 2').parentElement?.textContent).toContain('New');
    expect(screen.getByText('1 published photo is removed in this version.')).toBeTruthy();
    // History, newest first, with this version marked.
    expect(screen.getByText('Revision 2 · this version')).toBeTruthy();
    expect(screen.getByText(/Published · /)).toBeTruthy();
  });

  it('has nothing to decide on a version that is no longer pending', () => {
    mount({ state: 'closed', requiredChecks: [], warnings: [] });
    expect(
      screen.getByText('This version was decided or replaced. There is nothing to decide.'),
    ).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Approve' })).toBeNull();
  });

  it('offers Take down only with the delete key, even to a reviewer who can approve', () => {
    mount({}, true, '/next', images, false);
    expect(screen.getByRole('button', { name: 'Approve' })).toBeTruthy();
    expect(screen.queryByRole('button', { name: /Take down/ })).toBeNull();
    expect(screen.getByRole('button', { name: 'View large: Photo 1' })).toBeTruthy();
  });

  it('is view only without the decide permission: no checks and no Take down', () => {
    mount({}, false);
    expect(screen.getByText("View only. You can't decide on product versions.")).toBeTruthy();
    expect(screen.queryByRole('checkbox')).toBeNull();
    expect(screen.queryByRole('button', { name: /Take down/ })).toBeNull();
  });
});

describe('VersionReview edge cases', () => {
  it('never shows unread photos as no photos, and holds Approve until they load', () => {
    mount({ requiredChecks: [] }, true, '/next', null);
    expect(
      screen.getByText(
        'The photos could not be loaded. Reload the page to see them before you decide.',
      ),
    ).toBeTruthy();
    expect(screen.queryByText('This version has no photos.')).toBeNull();
    expect(screen.getByRole<HTMLButtonElement>('button', { name: 'Approve' }).disabled).toBe(true);
    expect(screen.getByText('Load the photos before you approve.')).toBeTruthy();
  });

  it('calls a first publication New, not Changed, and its details not changed', () => {
    mount({ published: null });
    expect(screen.queryByText('Changed')).toBeNull();
    expect(screen.getAllByText('New').length).toBeGreaterThan(0);
    expect(screen.getByRole('heading', { name: 'Details' })).toBeTruthy();
  });

  it('shows an unknown check by its code', () => {
    mount({ requiredChecks: ['future-check'] });
    expect(screen.getByLabelText('future-check')).toBeTruthy();
  });

  it('closes Send back on a stale version, so Reload is in reach', async () => {
    mount();
    fireEvent.click(screen.getByRole('button', { name: 'Send back' }));
    const dialog = dialogTitled('Send this version back?');
    fireEvent.change(dialog.getByLabelText('Reason'), { target: { value: 'photos' } });
    fail(409, 'review.not-current-revision');
    fireEvent.click(dialog.getByRole('button', { name: 'Send back', hidden: true }));
    await waitFor(() => screen.getByRole('button', { name: 'Reload' }));
    expect(dialog.queryByLabelText('Reason')).toBeNull();
  });
});

describe('VersionReview decision', () => {
  it('approves only once every check is ticked, with the version and the checks', async () => {
    mount();
    const approve = screen.getByRole('button', { name: 'Approve' });
    expect((approve as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByText('Tick every check to approve.')).toBeTruthy();
    fireEvent.click(screen.getByLabelText('The photos show no certification mark'));
    expect((approve as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(screen.getByLabelText('The tax category fits the product'));
    expect((approve as HTMLButtonElement).disabled).toBe(false);
    ok();
    fireEvent.click(approve);
    await waitFor(() => expect(screen.getByText('Approved. The version is live.')).toBeTruthy());
    expect(call).toHaveBeenCalledWith(
      'POST',
      `${base}/approve`,
      { version: 7, checksConfirmed: ['photos-no-certification-mark', 'tax-category-fits'] },
      'csrf-1',
    );
    expect(screen.getByRole('link', { name: 'Back to queue' }).getAttribute('href')).toBe(
      '/review',
    );
    expect(screen.getByRole('link', { name: 'Next in queue' }).getAttribute('href')).toBe('/next');
  });

  it('needs a reason to send back, then sends it with the version', async () => {
    mount({}, true, null);
    fireEvent.click(screen.getByRole('button', { name: 'Send back' }));
    const dialog = dialogTitled('Send this version back?');
    fireEvent.click(dialog.getByRole('button', { name: 'Send back', hidden: true }));
    expect(dialog.getByText('Choose a reason.')).toBeTruthy();
    expect(call).not.toHaveBeenCalled();
    fireEvent.change(dialog.getByLabelText('Reason'), { target: { value: 'photos' } });
    ok();
    fireEvent.click(dialog.getByRole('button', { name: 'Send back', hidden: true }));
    await waitFor(() => expect(screen.getByText('Sent back to the seller.')).toBeTruthy());
    expect(call).toHaveBeenCalledWith(
      'POST',
      `${base}/request-changes`,
      { version: 7, reasonCode: 'photos' },
      'csrf-1',
    );
    expect(screen.queryByRole('link', { name: 'Next in queue' })).toBeNull();
  });

  it('opens Send back with Description claim when a text claim is refused', async () => {
    mount({ requiredChecks: [] });
    fail(422, 'claim-text.refused');
    fireEvent.click(screen.getByRole('button', { name: 'Approve' }));
    await waitFor(() =>
      expect(
        screen.getByText(
          'A text makes a claim that is not allowed. Send it back with Description claim.',
        ),
      ).toBeTruthy(),
    );
    const dialog = dialogTitled('Send this version back?');
    expect(dialog.getByLabelText<HTMLSelectElement>('Reason').value).toBe('description-claim');
  });

  it('offers Reload on a stale version, and sends a signed-out admin away', async () => {
    mount({ requiredChecks: [] });
    fail(409, 'review.not-current-revision');
    fireEvent.click(screen.getByRole('button', { name: 'Approve' }));
    await waitFor(() => screen.getByRole('button', { name: 'Reload' }));
    fireEvent.click(screen.getByRole('button', { name: 'Reload' }));
    expect(reload).toHaveBeenCalled();
    fail(401, 'session.invalid');
    fireEvent.click(screen.getByRole('button', { name: 'Approve' }));
    await waitFor(() => expect(assign).toHaveBeenCalledWith('/session-ended'));
  });
});

describe('VersionReview photo takedown', () => {
  it('needs a reason, warns it cannot be undone, and marks the photo taken down', async () => {
    mount();
    fireEvent.click(screen.getByRole('button', { name: 'Take down Photo 2' }));
    const dialog = dialogTitled('Take down Photo 2?');
    expect(dialog.getByText(/This cannot be undone/)).toBeTruthy();
    fireEvent.click(dialog.getByRole('button', { name: 'Take down photo', hidden: true }));
    expect(dialog.getByText('Choose a reason.')).toBeTruthy();
    expect(call).not.toHaveBeenCalled();
    fireEvent.change(dialog.getByLabelText('Reason'), { target: { value: 'certification-mark' } });
    ok();
    fireEvent.click(dialog.getByRole('button', { name: 'Take down photo', hidden: true }));
    await waitFor(() => expect(screen.getByText('Taken down, not shown')).toBeTruthy());
    expect(call).toHaveBeenCalledWith(
      'POST',
      `catalog/admin/products/${PRODUCT}/images/${IMG(3)}/take-down`,
      { reasonCode: 'certification-mark' },
      'csrf-1',
    );
    expect(screen.queryByRole('button', { name: 'Take down Photo 2' })).toBeNull();
  });

  it('keeps the dialog open with the error when the takedown fails', async () => {
    mount();
    fireEvent.click(screen.getByRole('button', { name: 'Take down Photo 1' }));
    const dialog = dialogTitled('Take down Photo 1?');
    fireEvent.change(dialog.getByLabelText('Reason'), { target: { value: 'rights' } });
    fail(503, 'access.unavailable');
    fireEvent.click(dialog.getByRole('button', { name: 'Take down photo', hidden: true }));
    await waitFor(() =>
      expect(dialog.getByText('Something went wrong for a moment. Try again.')).toBeTruthy(),
    );
    expect(screen.queryByText('Taken down, not shown')).toBeNull();
  });
});
