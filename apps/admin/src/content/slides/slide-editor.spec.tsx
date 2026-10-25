// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { NextIntlClientProvider } from 'next-intl';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import messages from '../../../messages/en.json';

const router = { replace: vi.fn(), push: vi.fn(), refresh: vi.fn() };
vi.mock('next/navigation', () => ({ useRouter: () => router }));
vi.mock('../../api/client.ts', () => ({ callApi: vi.fn() }));

import { callApi } from '../../api/client.ts';
import { CATEGORY, ID, detail, version } from './test-data.ts';
import { SlideEditor } from './slide-editor.tsx';
import type { SlideDetail } from './slide-types.ts';

const call = vi.mocked(callApi);

function mount(props: Partial<React.ComponentProps<typeof SlideEditor>> = {}) {
  return render(
    <NextIntlClientProvider locale="en-AU" messages={messages}>
      <SlideEditor slide={null} canEdit csrfToken="csrf-1" zone="Australia/Brisbane" {...props} />
    </NextIntlClientProvider>,
  );
}
const type = (label: string | RegExp, value: string) =>
  fireEvent.change(screen.getByLabelText(label), { target: { value } });
const save = () => fireEvent.click(screen.getByRole('button', { name: 'Save to draft' }));

beforeEach(() => {
  vi.clearAllMocks();
});
afterEach(cleanup);

describe('new slide', () => {
  it('shows an empty form with the three types, counters and the approval note', () => {
    mount();
    expect(screen.getByRole('heading', { level: 1, name: 'New slide' })).toBeTruthy();
    const group = screen.getByRole('group', { name: 'Type' });
    expect(within(group).getAllByRole('radio')).toHaveLength(3);
    expect(screen.getByRole<HTMLInputElement>('radio', { name: /Promotion/ }).checked).toBe(true);
    expect(screen.getByText('0 / 60')).toBeTruthy();
    expect(screen.getByText('0 / 160')).toBeTruthy();
    expect(screen.getByText('0 / 24')).toBeTruthy();
    expect(
      screen.getByText('Buyers see changes only after a platform admin approves.'),
    ).toBeTruthy();
    expect(screen.getByText(/saved as a draft at Home · top for 30 days/)).toBeTruthy();
    // Only the Content tab is there so far.
    expect(
      within(screen.getByRole('navigation', { name: 'Slide sections' })).getAllByRole('link'),
    ).toHaveLength(1);
  });

  it('has a label for every control and no field for a URL', () => {
    mount();
    for (const label of [
      'Internal name',
      'Headline',
      /^Text/,
      /^Button label/,
      'Opens',
      'Image',
      'Sponsored by a seller',
    ]) {
      expect(screen.getByLabelText(label)).toBeTruthy();
    }
    expect(screen.queryByLabelText(/url|address/i)).toBeNull();
    // The description field only appears with a picture.
    expect(screen.queryByLabelText('Image description for screen readers')).toBeNull();
    type('Image', 'bread');
    expect(screen.getByLabelText('Image description for screen readers')).toBeTruthy();
  });

  it('counts what is typed', () => {
    mount();
    type('Headline', 'Diwali sweets, delivered');
    expect(screen.getByText('24 / 60')).toBeTruthy();
  });

  it('asks for a name and a headline, focuses the first marked field and sends nothing', async () => {
    mount();
    save();
    expect(await screen.findByRole('alert')).toBeTruthy();
    expect(screen.getAllByText('Fill this in.')).toHaveLength(2);
    await waitFor(() =>
      expect(document.activeElement).toBe(screen.getByLabelText('Internal name')),
    );
    expect(screen.getByLabelText('Internal name').getAttribute('aria-invalid')).toBe('true');
    expect(call).not.toHaveBeenCalled();
  });

  it('requires a description once a picture is chosen', () => {
    mount();
    type('Internal name', 'Name');
    type('Headline', 'Head');
    type('Image', 'bread');
    save();
    expect(
      screen.getByText('Describe the image. Required when a slide has an image.'),
    ).toBeTruthy();
    expect(call).not.toHaveBeenCalled();
  });

  it('needs something to open for a button', () => {
    mount();
    type('Internal name', 'Name');
    type('Headline', 'Head');
    type(/^Button label/, 'Shop');
    save();
    expect(
      screen.getByText('A button needs something to open. Choose what it opens.'),
    ).toBeTruthy();
  });

  it('asks for the id of the chosen target, named by its kind', () => {
    mount();
    type('Opens', 'seller');
    expect(screen.getByLabelText('Seller ID')).toBeTruthy();
    type('Opens', 'search');
    expect(screen.getByLabelText('Saved search code')).toBeTruthy();
    type('Opens', 'category');
    type('Category ID', 'not-an-id');
    type('Internal name', 'Name');
    type('Headline', 'Head');
    save();
    expect(screen.getByText(/Enter a valid id/)).toBeTruthy();
  });

  it('creates the slide, sends the whole draft with the default window, and opens it', async () => {
    call.mockResolvedValueOnce({ ok: true, status: 201, body: detail() });
    mount();
    fireEvent.click(screen.getByRole('radio', { name: /Link/ }));
    type('Internal name', '  Diwali sweets week ');
    type('Headline', 'Diwali sweets, delivered');
    type(/^Text/, 'Barfi and ladoo');
    type(/^Button label/, 'Shop sweets');
    type('Opens', 'category');
    type('Category ID', CATEGORY);
    type('Image', 'bread');
    type('Image description for screen readers', 'A tray of sweets');
    fireEvent.click(screen.getByLabelText('Sponsored by a seller'));
    save();
    await waitFor(() => expect(router.push).toHaveBeenCalledWith(`/content/slides/${ID}`));
    const [method, path, body, csrf] = call.mock.calls[0]!;
    expect([method, path, csrf]).toEqual(['POST', 'storefront/admin/slides', 'csrf-1']);
    expect(body).toMatchObject({
      kind: 'link',
      internalName: 'Diwali sweets week',
      sponsored: true,
      pinned: false,
      content: {
        title: 'Diwali sweets, delivered',
        body: 'Barfi and ladoo',
        ctaLabel: 'Shop sweets',
        image: { ref: 'bread', alt: 'A tray of sweets', decorative: false },
        link: { type: 'category', id: CATEGORY },
      },
      placements: [{ position: 'home.hero', scope: 'all' }],
    });
    const sent = body as { startsAt: string; endsAt: string };
    expect(Date.parse(sent.endsAt) - Date.parse(sent.startsAt)).toBe(30 * 24 * 60 * 60 * 1000);
  });

  it('maps validation.failed fields onto the form fields', async () => {
    call.mockResolvedValueOnce({
      ok: false,
      failure: {
        status: 400,
        code: 'validation.failed',
        details: {
          fields: [
            { path: 'content.title', code: 'url' },
            { path: 'content.body', code: 'length' },
            { path: 'internalName', code: 'markup' },
          ],
        },
      },
    });
    mount();
    type('Internal name', 'Name');
    type('Headline', 'Head');
    save();
    expect(await screen.findByText(/Web addresses and links are not allowed/)).toBeTruthy();
    expect(screen.getByText('Too long. Use up to 160 characters.')).toBeTruthy();
    expect(screen.getByText(/without < or > characters/)).toBeTruthy();
    expect(screen.getByLabelText('Headline').getAttribute('aria-invalid')).toBe('true');
    expect(router.push).not.toHaveBeenCalled();
    // Typing in a marked field clears its error.
    type('Headline', 'Another');
    expect(screen.getByLabelText('Headline').getAttribute('aria-invalid')).toBeNull();
  });

  it('keeps what was typed and says so when the connection fails', async () => {
    call.mockResolvedValueOnce({ ok: false, failure: { status: 0, code: 'network' } });
    mount();
    type('Internal name', 'Name');
    type('Headline', 'Head');
    save();
    expect((await screen.findByRole('alert')).textContent).toContain('No connection');
    expect(screen.getByLabelText<HTMLInputElement>('Headline').value).toBe('Head');
  });

  it('says why a refused save was refused for other answers', async () => {
    for (const [failure, text] of [
      [{ status: 403, code: 'access.denied' }, /permission to change slides/],
      [{ status: 500, code: 'unknown' }, /could not be saved/],
      [{ status: 409, code: 'storefront.slide-version-limit' }, /limit of saved versions/],
    ] as const) {
      call.mockResolvedValueOnce({ ok: false, failure });
      const view = mount();
      type('Internal name', 'Name');
      type('Headline', 'Head');
      save();
      expect((await screen.findByRole('alert')).textContent).toMatch(text);
      view.unmount();
    }
  });

  it('sends a signed-out editor to the session page', async () => {
    call.mockResolvedValueOnce({
      ok: false,
      failure: { status: 401, code: 'access.unauthenticated' },
    });
    mount();
    type('Internal name', 'Name');
    type('Headline', 'Head');
    save();
    await waitFor(() => expect(router.replace).toHaveBeenCalledWith('/session-ended'));
  });

  it('discards what was typed', () => {
    mount();
    expect(screen.getByRole<HTMLButtonElement>('button', { name: 'Discard' }).disabled).toBe(true);
    type('Headline', 'Head');
    fireEvent.click(screen.getByRole('button', { name: 'Discard' }));
    expect(screen.getByLabelText<HTMLInputElement>('Headline').value).toBe('');
  });

  it('sends one request even when Save is pressed twice', async () => {
    let finish: (value: Awaited<ReturnType<typeof callApi>>) => void = () => undefined;
    call.mockReturnValueOnce(new Promise((resolve) => (finish = resolve)));
    mount();
    type('Internal name', 'Name');
    type('Headline', 'Head');
    save();
    save();
    expect(call).toHaveBeenCalledTimes(1);
    finish({ ok: true, status: 201, body: detail() });
    await waitFor(() => expect(router.push).toHaveBeenCalled());
  });
});

describe('existing slide', () => {
  it('shows the draft: header badges for the live and the draft version, filled fields', () => {
    mount({ slide: detail() });
    expect(screen.getByRole('heading', { level: 1, name: 'Diwali sweets week' })).toBeTruthy();
    const badges = screen.getByRole('group', { name: 'Versions of this slide' });
    expect(within(badges).getByText('Scheduled v2')).toBeTruthy();
    expect(within(badges).getByText('Draft v3 · not sent for approval')).toBeTruthy();
    expect(screen.getByLabelText<HTMLInputElement>('Headline').value).toBe(
      'Diwali sweets, delivered',
    );
    expect(screen.getByLabelText<HTMLSelectElement>('Opens').value).toBe('category');
    expect(screen.getByLabelText<HTMLInputElement>('Category ID').value).toBe(CATEGORY);
    expect(screen.getByLabelText<HTMLSelectElement>('Image').value).toBe('bread');
    expect(
      screen.getByText(
        /Shown at Home · top\. Live 27 Oct, 12:00 am – 3 Nov, 11:59 pm \(Australia\/Brisbane\)/,
      ),
    ).toBeTruthy();
  });

  it('shows a draft waiting for approval, and a slide that is not live yet', () => {
    mount({ slide: detail({ live: null, status: 'pending', pending: true }) });
    expect(screen.getByText('Not live yet')).toBeTruthy();
    expect(screen.getByText('Draft v3 · waiting for approval')).toBeTruthy();
  });

  it('shows the live version when there is no draft', () => {
    mount({ slide: detail({ draft: null, status: 'live', hasDraft: false }) });
    expect(screen.getByText('Live v2')).toBeTruthy();
    expect(screen.getByLabelText<HTMLInputElement>('Headline').value).toBe(
      'Diwali sweets, delivered',
    );
  });

  it('keeps the type fixed after creation', () => {
    mount({ slide: detail() });
    expect(screen.getByText('The type is chosen when the slide is created.')).toBeTruthy();
    for (const radio of screen.getAllByRole('radio')) expect(radio.matches(':disabled')).toBe(true);
  });

  it('replaces the whole draft with the saved window and positions, never the kind', async () => {
    const saved: SlideDetail = detail({
      draft: version({
        versionNo: 4,
        content: { title: 'A new headline', textPosition: 'start', textTone: 'light' },
      }),
    });
    call.mockResolvedValueOnce({ ok: true, status: 200, body: saved });
    mount({ slide: detail({ draft: version({ versionNo: 3, pinned: true }) }) });
    type('Headline', 'A new headline');
    save();
    expect(await screen.findByText('Saved to draft as version 4.')).toBeTruthy();
    const [method, path, body, csrf] = call.mock.calls[0]!;
    expect([method, path, csrf]).toEqual(['PUT', `storefront/admin/slides/${ID}`, 'csrf-1']);
    expect(body).toMatchObject({
      internalName: 'Diwali sweets week',
      startsAt: '2026-10-26T14:00:00Z',
      endsAt: '2026-11-03T13:59:00Z',
      pinned: true,
      placements: [{ position: 'home.hero' }],
      content: { title: 'A new headline', link: { type: 'category', id: CATEGORY } },
    });
    expect('kind' in (body as object)).toBe(false);
    expect(router.push).not.toHaveBeenCalled();
    // The result is announced politely and the badges show the new draft.
    expect(screen.getByRole('status').textContent).toBe('Saved to draft as version 4.');
    expect(screen.getByText('Draft v4 · not sent for approval')).toBeTruthy();
  });

  it('is read-only without the edit permission: no Save bar, every field disabled', () => {
    mount({ slide: detail(), canEdit: false });
    expect(screen.getByText('You can view slides but not change them.')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Save to draft' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Discard' })).toBeNull();
    expect(
      screen.queryByText('Buyers see changes only after a platform admin approves.'),
    ).toBeNull();
    const form = screen.getByRole('form', { name: 'Slide content' });
    for (const control of within(form).getAllByRole('textbox')) {
      expect((control as HTMLInputElement).matches(':disabled')).toBe(true);
    }
    expect(
      screen.getByLabelText<HTMLInputElement>('Sponsored by a seller').matches(':disabled'),
    ).toBe(true);
  });

  it('is read-only on an archived slide even for an editor', () => {
    mount({ slide: detail({ status: 'archived' }) });
    expect(screen.getByText('This slide is archived. It cannot be changed.')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Save to draft' })).toBeNull();
    expect(screen.getByText('Archived v2')).toBeTruthy();
  });

  it('shows the new slide note only on /new', () => {
    mount({ slide: detail() });
    expect(screen.queryByText(/saved as a draft at Home · top/)).toBeNull();
  });
});

describe('preview', () => {
  it('shows the headline, text and button as typed, and switches size', () => {
    mount();
    expect(screen.getByText('Your headline appears here')).toBeTruthy();
    type('Headline', 'Diwali sweets, delivered');
    type(/^Text/, 'Barfi and ladoo');
    const preview = screen.getByRole('complementary', { name: 'Preview' });
    expect(within(preview).getByText('Diwali sweets, delivered')).toBeTruthy();
    expect(within(preview).getByText('Barfi and ladoo')).toBeTruthy();
    // The button needs a target, like the buyer slide.
    type(/^Button label/, 'Shop sweets');
    expect(within(preview).queryByText('Shop sweets')).toBeNull();
    type('Opens', 'category');
    expect(within(preview).getByText('Shop sweets')).toBeTruthy();
    const sizes = within(preview).getAllByRole('button');
    expect(sizes.map((b) => b.textContent)).toEqual(['375', '768', '1280']);
    expect(sizes[2]!.getAttribute('aria-pressed')).toBe('true');
    fireEvent.click(sizes[0]!);
    expect(sizes[0]!.getAttribute('aria-pressed')).toBe('true');
    expect(
      within(preview).getByRole('img', { name: 'Preview of the slide at 375 pixels' }),
    ).toBeTruthy();
  });

  it('marks a sponsored slide and shows the chosen picture', () => {
    mount();
    fireEvent.click(screen.getByLabelText('Sponsored by a seller'));
    type('Image', 'meat');
    const preview = screen.getByRole('complementary', { name: 'Preview' });
    expect(within(preview).getByText('Sponsored')).toBeTruthy();
    expect(within(preview).getByText('Picture: Meat')).toBeTruthy();
  });
});
