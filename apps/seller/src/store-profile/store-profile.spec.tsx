// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { NextIntlClientProvider } from 'next-intl';
import type { ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import messages from '../../messages/en.json';
import { settingsTabs } from '../settings/settings-header.tsx';

vi.mock('../api/client.ts', () => ({ callApi: vi.fn() }));
vi.mock('../catalog/photo-prepare.ts', () => ({ preparePhoto: vi.fn() }));

import { callApi, type ApiFailure } from '../api/client.ts';
import { preparePhoto } from '../catalog/photo-prepare.ts';
import { aboutProblemOf, imageProblemOf } from './errors.ts';
import { StoreProfile } from './store-profile.tsx';
import type { StoreProfileView } from './types.ts';

const call = vi.mocked(callApi);
const prepare = vi.mocked(preparePhoto);
const wrap = (node: ReactNode) => (
  <NextIntlClientProvider locale="en-AU" messages={messages}>
    {node}
  </NextIntlClientProvider>
);

const IMAGE = '0190a000-0000-7000-8000-0000000000a1';
const view = (over: Partial<StoreProfileView> = {}): StoreProfileView => ({
  version: 2,
  about: { 'en-AU': 'Family bakery.' },
  defaultLocale: 'en-AU',
  locales: ['en-AU'],
  logo: null,
  banner: null,
  aboutMaxLength: 2000,
  imageMaxBytes: 4 * 1024 * 1024,
  ...over,
});
const failure = (over: Partial<ApiFailure>): { ok: false; failure: ApiFailure } => ({
  ok: false,
  failure: { status: 400, code: 'unknown', ...over },
});
const done = (body: StoreProfileView) => ({ ok: true as const, status: 200, body });

const mount = (initial = view(), canEdit = true) =>
  render(wrap(<StoreProfile initial={initial} csrfToken="csrf" canEdit={canEdit} />));
const box = () => screen.getByLabelText(/About your store/);

beforeEach(() => vi.clearAllMocks());
afterEach(cleanup);

describe('StoreProfile About card', () => {
  it('shows the saved text, a counter and a Save that waits for a change', () => {
    mount();
    expect((box() as HTMLTextAreaElement).value).toBe('Family bakery.');
    expect(screen.getByText('14 of 2000 characters')).toBeTruthy();
    expect(screen.getByRole<HTMLButtonElement>('button', { name: 'Save' }).disabled).toBe(true);
  });

  it('saves with the version it loaded, shows the saved line and takes the server text', async () => {
    mount();
    call.mockResolvedValueOnce(
      done(view({ version: 3, about: { 'en-AU': 'Family bakery, since 1990.' } })),
    );

    fireEvent.change(box(), { target: { value: '  Family bakery, since 1990.  ' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));

    await screen.findByText('Saved. Buyers can see it now.');
    expect(call).toHaveBeenCalledWith(
      'PUT',
      'sellers/store-profile/about',
      { expectedVersion: 2, about: { 'en-AU': '  Family bakery, since 1990.  ' } },
      'csrf',
    );
    expect((box() as HTMLTextAreaElement).value).toBe('Family bakery, since 1990.');
    expect(screen.getByRole<HTMLButtonElement>('button', { name: 'Save' }).disabled).toBe(true);
  });

  it('shows Saving… and ignores a second click while the save runs', async () => {
    mount();
    let finish: (value: ReturnType<typeof done>) => void = () => undefined;
    call.mockReturnValueOnce(new Promise((resolve) => (finish = resolve)));

    fireEvent.change(box(), { target: { value: 'New text' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    const saving = await screen.findByRole('button', { name: 'Saving…' });
    fireEvent.click(saving);
    finish(done(view({ version: 3, about: { 'en-AU': 'New text' } })));

    await screen.findByText('Saved. Buyers can see it now.');
    expect(call).toHaveBeenCalledTimes(1);
  });

  it('counts characters as people do and refuses a text over the limit before sending', () => {
    mount(view({ aboutMaxLength: 10 }));
    fireEvent.change(box(), { target: { value: '😀'.repeat(11) } });

    expect(screen.getByText('11 of 10 characters')).toBeTruthy();
    expect(screen.getByText('Use at most 10 characters.')).toBeTruthy();
    expect(screen.getByRole<HTMLButtonElement>('button', { name: 'Save' }).disabled).toBe(true);
    expect(call).not.toHaveBeenCalled();
  });

  it('points at the claim term and the link rule on the field that has them', async () => {
    mount();
    call.mockResolvedValueOnce(
      failure({
        code: 'validation.failed',
        details: { fields: [{ path: 'about.en-AU', code: 'claim-term' }] },
      }),
    );

    fireEvent.change(box(), { target: { value: 'We are certified bakers' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));

    await screen.findByText(/This text claims a certification/);
    // One announcement of the failure: the field's own alert, with no second banner above it.
    expect(screen.getAllByRole('alert')).toHaveLength(1);
    expect(box().getAttribute('aria-invalid')).toBe('true');
    expect(call).toHaveBeenCalledTimes(1);
  });

  it('shows the stale conflict, keeps the text, and loads the latest on request', async () => {
    mount();
    call.mockResolvedValueOnce(failure({ status: 409, code: 'conflict.stale' }));
    fireEvent.change(box(), { target: { value: 'My edit' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));

    await screen.findByText(/Someone else saved a newer version first/);
    expect((box() as HTMLTextAreaElement).value).toBe('My edit');

    call.mockResolvedValueOnce(done(view({ version: 5, about: { 'en-AU': 'Their text' } })));
    fireEvent.click(screen.getByRole('button', { name: 'Show the latest version' }));

    await waitFor(() => expect((box() as HTMLTextAreaElement).value).toBe('Their text'));
    expect(call).toHaveBeenLastCalledWith('GET', 'sellers/store-profile');
    expect(screen.queryByText(/Someone else saved/)).toBeNull();

    // The next save names the version that was loaded.
    call.mockResolvedValueOnce(done(view({ version: 6, about: { 'en-AU': 'Merged' } })));
    fireEvent.change(box(), { target: { value: 'Merged' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    await screen.findByText('Saved. Buyers can see it now.');
    expect(call).toHaveBeenLastCalledWith(
      'PUT',
      'sellers/store-profile/about',
      { expectedVersion: 5, about: { 'en-AU': 'Merged' } },
      'csrf',
    );
  });

  it('says how long to wait when saves are throttled', async () => {
    mount();
    call.mockResolvedValueOnce(
      failure({ status: 429, code: 'request.throttled', details: { retryAfterSeconds: 12 } }),
    );
    fireEvent.change(box(), { target: { value: 'x' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));

    await screen.findByText('Too many saves. Wait 12 seconds and try again.');
  });

  it('shows an unavailable message when the service is down, and keeps the text', async () => {
    mount();
    call.mockResolvedValueOnce(failure({ status: 503, code: 'sellers.unavailable' }));
    fireEvent.change(box(), { target: { value: 'Kept' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));

    await screen.findByText('The store profile is unavailable right now. Try again later.');
    expect((box() as HTMLTextAreaElement).value).toBe('Kept');
  });

  it('sends a signed-out seller to the session-ended page', async () => {
    const assign = vi.fn();
    vi.stubGlobal('location', { ...window.location, assign });
    mount();
    call.mockResolvedValueOnce(failure({ status: 401, code: 'session.invalid' }));
    fireEvent.change(box(), { target: { value: 'x' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));

    await waitFor(() => expect(assign).toHaveBeenCalledWith('/session-ended'));
    vi.unstubAllGlobals();
  });

  it('offers one box per locale of the Market, named by language', () => {
    mount(view({ locales: ['ja-JP', 'en-US'], about: { 'ja-JP': 'こんにちは', 'en-US': '' } }));

    expect(screen.getByLabelText(/About your store \(Japanese/)).toBeTruthy();
    expect(screen.getByLabelText(/About your store \(United States English/)).toBeTruthy();
  });
});

describe('StoreProfile images', () => {
  const file = () => new File([new Uint8Array([1, 2, 3])], 'logo.png', { type: 'image/png' });
  const logoCard = () => screen.getByRole('heading', { name: 'Logo' }).closest('section')!;
  const bannerCard = () => screen.getByRole('heading', { name: 'Banner' }).closest('section')!;
  const chooseIn = (card: HTMLElement) =>
    card.querySelector('input[type=file]') as HTMLInputElement;

  it('shows an empty state for a missing logo and banner, and the pictures when there are some', () => {
    const empty = mount();
    expect(screen.getByText('No logo yet.')).toBeTruthy();
    expect(screen.getByText('No banner yet.')).toBeTruthy();
    expect(within(logoCard()).queryByRole('img')).toBeNull();
    empty.unmount();

    mount(
      view({
        logo: { id: IMAGE, width: 512, height: 512 },
        banner: { id: IMAGE, width: 1536, height: 384 },
      }),
    );
    const logo = within(logoCard()).getByRole('img', { name: 'Your store logo' });
    const banner = within(bannerCard()).getByRole('img', { name: 'Your store banner' });
    expect(logo.getAttribute('src')).toBe(`/api/sellers/store-profile/images/${IMAGE}/small`);
    expect(banner.getAttribute('src')).toBe(`/api/sellers/store-profile/images/${IMAGE}/large`);
    expect(banner.getAttribute('width')).toBe('1536');
    expect(banner.getAttribute('height')).toBe('384');
  });

  it('uploads a shrunk picture to the right route and shows it', async () => {
    mount();
    prepare.mockResolvedValueOnce({ kind: 'ready', data: 'QUJD' });
    call.mockResolvedValueOnce(done(view({ banner: { id: IMAGE, width: 1536, height: 384 } })));

    fireEvent.change(chooseIn(bannerCard()), { target: { files: [file()] } });

    await screen.findByText('Banner saved. Buyers can see it now.');
    expect(call).toHaveBeenCalledWith(
      'PUT',
      'sellers/store-profile/banner',
      { data: 'QUJD' },
      'csrf',
    );
    expect(within(bannerCard()).getByRole('img', { name: 'Your store banner' })).toBeTruthy();
    expect(within(bannerCard()).getByText('Replace')).toBeTruthy();
    // The logo is untouched.
    expect(screen.getByText('No logo yet.')).toBeTruthy();
  });

  it('shows Uploading… while the call runs', async () => {
    mount();
    prepare.mockResolvedValueOnce({ kind: 'ready', data: 'QUJD' });
    let finish: (value: ReturnType<typeof done>) => void = () => undefined;
    call.mockReturnValueOnce(new Promise((resolve) => (finish = resolve)));

    fireEvent.change(chooseIn(logoCard()), { target: { files: [file()] } });

    await waitFor(() =>
      expect(within(logoCard()).getByRole('status').textContent).toBe('Uploading…'),
    );
    expect(chooseIn(logoCard()).disabled).toBe(true);
    finish(done(view({ logo: { id: IMAGE, width: 512, height: 512 } })));
    await screen.findByText('Logo saved. Buyers can see it now.');
  });

  it.each([
    ['file.too-small', 422, 'That logo is too small. Use at least 128 by 128 pixels.'],
    ['file.unsupported-type', 415, 'That file is not a JPEG, PNG or WebP picture.'],
    ['file.too-many-pixels', 422, 'That picture has too many pixels. Choose a smaller one.'],
    ['file.unreadable', 422, 'We could not read that picture. Try another file.'],
    ['sellers.unavailable', 503, 'The store profile is unavailable right now. Try again later.'],
  ])('explains %s', async (code, status, message) => {
    mount();
    prepare.mockResolvedValueOnce({ kind: 'ready', data: 'QUJD' });
    call.mockResolvedValueOnce(failure({ status, code }));

    fireEvent.change(chooseIn(logoCard()), { target: { files: [file()] } });

    await within(logoCard()).findByText(message);
    expect(within(logoCard()).queryByRole('img')).toBeNull();
  });

  it('explains a banner that is too small in banner terms, and a file the browser cannot read', async () => {
    mount();
    prepare.mockResolvedValueOnce({ kind: 'ready', data: 'QUJD' });
    call.mockResolvedValueOnce(failure({ status: 422, code: 'file.too-small' }));
    fireEvent.change(chooseIn(bannerCard()), { target: { files: [file()] } });
    await within(bannerCard()).findByText(
      'That banner is too small. Use at least 1200 by 300 pixels.',
    );

    prepare.mockResolvedValueOnce({ kind: 'refused', reason: 'unreadable' });
    fireEvent.change(chooseIn(bannerCard()), { target: { files: [file()] } });
    await within(bannerCard()).findByText('We could not read that picture. Try another file.');
    expect(call).toHaveBeenCalledTimes(1);
  });

  it('asks before removing, then removes and shows the empty state', async () => {
    mount(view({ logo: { id: IMAGE, width: 512, height: 512 } }));
    call.mockResolvedValueOnce(done(view()));

    fireEvent.click(within(logoCard()).getByRole('button', { name: 'Remove' }));
    expect(within(logoCard()).getByText('Remove the logo?')).toBeTruthy();
    expect(call).not.toHaveBeenCalled();
    fireEvent.click(within(logoCard()).getByRole('button', { name: 'Yes, remove' }));

    await screen.findByText('Logo removed.');
    expect(call).toHaveBeenCalledWith('DELETE', 'sellers/store-profile/logo', undefined, 'csrf');
    expect(screen.getByText('No logo yet.')).toBeTruthy();
  });

  it('moves focus: Yes, remove on asking; back to Remove on cancel; Choose a picture after removing', async () => {
    mount(view({ logo: { id: IMAGE, width: 512, height: 512 } }));
    call.mockResolvedValueOnce(done(view()));

    fireEvent.click(within(logoCard()).getByRole('button', { name: 'Remove' }));
    expect(document.activeElement).toBe(
      within(logoCard()).getByRole('button', { name: 'Yes, remove' }),
    );
    fireEvent.click(within(logoCard()).getByRole('button', { name: 'Cancel' }));
    expect(document.activeElement).toBe(within(logoCard()).getByRole('button', { name: 'Remove' }));

    fireEvent.click(within(logoCard()).getByRole('button', { name: 'Remove' }));
    fireEvent.click(within(logoCard()).getByRole('button', { name: 'Yes, remove' }));
    await screen.findByText('Logo removed.');
    expect(document.activeElement).toBe(chooseIn(logoCard()));
    expect(within(logoCard()).getByText('Choose a picture')).toBeTruthy();
  });

  it('keeps an empty status region in each picture card from the start', () => {
    mount();
    for (const card of [logoCard(), bannerCard()]) {
      const status = within(card).getByRole('status');
      expect(status.textContent).toBe('');
    }
  });

  it('dims the old picture while a new one uploads', async () => {
    mount(view({ logo: { id: IMAGE, width: 512, height: 512 } }));
    prepare.mockResolvedValueOnce({ kind: 'ready', data: 'QUJD' });
    let finish: (value: ReturnType<typeof done>) => void = () => undefined;
    call.mockReturnValueOnce(new Promise((resolve) => (finish = resolve)));

    fireEvent.change(chooseIn(logoCard()), { target: { files: [file()] } });

    await waitFor(() =>
      expect(within(logoCard()).getByRole('img').className).toContain('opacity-50'),
    );
    finish(done(view({ logo: { id: IMAGE, width: 512, height: 512 } })));
    await screen.findByText('Logo saved. Buyers can see it now.');
    expect(within(logoCard()).getByRole('img').className).not.toContain('opacity-50');
  });

  it('previews the banner as buyers see it, on a phone or a wide screen, and says what is cropped', () => {
    mount(view({ banner: { id: IMAGE, width: 1536, height: 384 } }));
    const card = bannerCard();
    expect(within(card).getByText(/edges are cropped on phones and wide screens/)).toBeTruthy();
    expect(within(card).getByText(/1200 × 300 px/)).toBeTruthy();
    const box = () => within(card).getByRole('img').parentElement!;
    const phone = within(card).getByRole('button', { name: 'Phone' });
    const desktop = within(card).getByRole('button', { name: 'Desktop' });
    expect(phone.getAttribute('aria-pressed')).toBe('true');
    expect(box().className).toContain('aspect-banner-phone');
    expect(within(card).queryByText(/dashed square/)).toBeNull();

    fireEvent.click(desktop);

    expect(desktop.getAttribute('aria-pressed')).toBe('true');
    expect(phone.getAttribute('aria-pressed')).toBe('false');
    expect(box().className).toContain('aspect-banner-desktop');
    expect(within(card).getByText(/dashed square/)).toBeTruthy();
  });

  it('puts the removal question on its own line', () => {
    mount(view({ banner: { id: IMAGE, width: 1536, height: 384 } }));

    fireEvent.click(within(bannerCard()).getByRole('button', { name: 'Remove' }));

    expect(within(bannerCard()).getByText('Remove the banner?').className).toContain('basis-full');
  });

  it('keeps the picture when the removal is cancelled', () => {
    mount(view({ logo: { id: IMAGE, width: 512, height: 512 } }));

    fireEvent.click(within(logoCard()).getByRole('button', { name: 'Remove' }));
    fireEvent.click(within(logoCard()).getByRole('button', { name: 'Cancel' }));

    expect(within(logoCard()).getByRole('img', { name: 'Your store logo' })).toBeTruthy();
    expect(call).not.toHaveBeenCalled();
  });
});

describe('StoreProfile without the edit permission', () => {
  it('shows the view-only banner and the content, with no way to change it', () => {
    mount(view({ logo: { id: IMAGE, width: 512, height: 512 }, banner: null }), false);

    expect(screen.getByText(/You can see the store profile but not change it/)).toBeTruthy();
    expect((box() as HTMLTextAreaElement).readOnly).toBe(true);
    expect((box() as HTMLTextAreaElement).value).toBe('Family bakery.');
    expect(screen.queryByRole('button', { name: 'Save' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Remove' })).toBeNull();
    expect(document.querySelector('input[type=file]')).toBeNull();
    expect(screen.getByRole('img', { name: 'Your store logo' })).toBeTruthy();
  });
});

describe('store profile settings tab', () => {
  const ids = (keys: string[]) => settingsTabs(keys, (key) => key).map((tab) => tab.id);

  it('shows the tab only with the view permission', () => {
    expect(ids([])).not.toContain('store-profile');
    expect(ids(['sellers.store-profile.view'])).toContain('store-profile');
  });

  it('points at /store-profile', () => {
    const tab = settingsTabs(['sellers.store-profile.view'], (key) => key).find(
      (item) => item.id === 'store-profile',
    );
    expect(tab?.href).toBe('/store-profile');
    expect(tab?.label).toBe('settings.tab.store-profile');
  });
});

describe('problem mapping', () => {
  it('maps About failures to banners and per-locale rules', () => {
    expect(aboutProblemOf({ status: 409, code: 'conflict.stale' }).banner).toBe('stale');
    expect(aboutProblemOf({ status: 403, code: 'access.denied' }).banner).toBe('denied');
    expect(aboutProblemOf({ status: 403, code: 'request.csrf' }).banner).toBe('csrf');
    expect(aboutProblemOf({ status: 0, code: 'network' }).banner).toBe('unavailable');
    expect(aboutProblemOf({ status: 500, code: 'x' }).banner).toBe('unknown');
    expect(
      aboutProblemOf({
        status: 400,
        code: 'validation.failed',
        details: {
          fields: [
            { path: 'about.ja-JP', code: 'url' },
            { path: 'about.en-US', code: 'weird' },
            { path: 'about', code: 'locale' },
          ],
        },
      }),
    ).toEqual({ banner: null, fields: { 'ja-JP': 'url', 'en-US': 'invalid' } });
  });

  it('maps image failures, naming the kind where the size differs', () => {
    expect(imageProblemOf({ status: 422, code: 'file.too-small' }, 'banner').key).toBe(
      'too-small.banner',
    );
    expect(imageProblemOf({ status: 422, code: 'file.too-small' }, 'logo').key).toBe(
      'too-small.logo',
    );
    expect(imageProblemOf({ status: 413, code: 'file.too-large' }, 'logo').key).toBe('too-large');
    expect(
      imageProblemOf(
        { status: 429, code: 'request.throttled', details: { retryAfterSeconds: 4 } },
        'logo',
      ),
    ).toEqual({ key: 'throttled', retryAfterSeconds: 4 });
    expect(imageProblemOf({ status: 0, code: 'network' }, 'logo').key).toBe('unavailable');
  });
});
