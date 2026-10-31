// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { NextIntlClientProvider } from 'next-intl';
import type { ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import messages from '../../messages/en.json';

vi.mock('../api/client.ts', () => ({ callApi: vi.fn() }));
vi.mock('../catalog/photo-prepare.ts', () => ({ preparePhoto: vi.fn() }));

import { callApi, type ApiFailure } from '../api/client.ts';
import { preparePhoto } from '../catalog/photo-prepare.ts';
import { claimsCertification } from './claim-terms.ts';
import { aboutProblemOf, imageProblemOf, saveProblemOf } from './errors.ts';
import { StoreProfile } from './store-profile.tsx';
import type { StoreProfileView } from './types.ts';
import { expectToast } from '../../test/toast-spy.ts';

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

const mount = (initial = view(), canEdit = true, claimTerms: readonly string[] = []) =>
  render(
    wrap(
      <StoreProfile initial={initial} csrfToken="csrf" canEdit={canEdit} claimTerms={claimTerms} />,
    ),
  );
const box = () => screen.getByRole<HTMLTextAreaElement>('textbox', { name: /About your store/ });
const save = () => screen.getByRole<HTMLButtonElement>('button', { name: 'Save changes' });

/** One row of the Compare list: the saved and typed values, read as text. */
const compared = (label: string | RegExp) => {
  const list = screen.getByRole('list', { name: 'Changes compared' });
  const item = within(list).getByText(label).closest('li')!;
  const [saved, yours] = [...item.querySelectorAll('q')].map((q) => q.textContent);
  return { saved, yours, item };
};

beforeEach(() => vi.clearAllMocks());
afterEach(cleanup);

describe('claim wording, read live from the API terms', () => {
  it('finds a term as whole tokens in a row, in any case, width or spacing', () => {
    const terms = ['halal', 'halal certified'];
    expect(claimsCertification('We are HALAL', terms)).toBe(true);
    expect(claimsCertification('Ｈａｌａｌ meat', terms)).toBe(true);
    expect(claimsCertification('100% halal-certified!', ['halal certified'])).toBe(true);
    expect(claimsCertification('halalish', terms)).toBe(false);
    expect(claimsCertification('certified and then halal', ['halal certified'])).toBe(false);
    expect(claimsCertification('anything', [])).toBe(false);
    expect(claimsCertification('', terms)).toBe(false);
  });
});

describe('StoreProfile live About checks', () => {
  const terms = ['halal certified'];

  it('shows the certification error while typing, counts it and keeps Save off', () => {
    mount(view(), true, terms);
    fireEvent.change(box(), { target: { value: 'Family bakery, Halal Certified.' } });

    // Under the field and in the summary banner.
    expect(
      screen.getAllByText(/This text claims a certification\. Remove that wording\./),
    ).toHaveLength(2);
    expect(box().getAttribute('aria-invalid')).toBe('true');
    const bar = screen.getByRole('region', { name: 'Unsaved changes' });
    expect(bar.textContent).toContain('1 unsaved change');
    expect(bar.textContent).toContain('1 needs fixing');
    expect(screen.getByRole('alert').textContent).toContain('1 setting needs fixing');
    expect(save().disabled).toBe(true);
    expect(call).not.toHaveBeenCalled();

    fireEvent.change(box(), { target: { value: 'Family bakery, open daily.' } });
    expect(screen.queryAllByText(/This text claims a certification/)).toHaveLength(0);
    expect(screen.queryByRole('alert')).toBeNull();
    expect(save().disabled).toBe(false);
  });

  it('shows the length error while typing and clears it when the text is short enough again', () => {
    mount(view({ aboutMaxLength: 10 }), true, terms);
    fireEvent.change(box(), { target: { value: 'x'.repeat(11) } });
    expect(save().disabled).toBe(true);
    expect(screen.getByRole('alert')).toBeTruthy();
    fireEvent.change(box(), { target: { value: 'x'.repeat(10) } });
    expect(save().disabled).toBe(false);
  });

  it('does not warn on a saved text that is fine, and warns nothing without terms', () => {
    mount(view(), true, []);
    fireEvent.change(box(), { target: { value: 'Halal Certified bakery' } });
    expect(screen.queryAllByText(/This text claims a certification/)).toHaveLength(0);
    expect(save().disabled).toBe(false);
  });

  it('still shows the server refusal of a claim the live check could not see', async () => {
    mount(view(), true, terms);
    fireEvent.change(box(), { target: { value: 'Pure h a l a l bakery' } });
    call.mockResolvedValueOnce(
      failure({
        status: 400,
        code: 'validation.failed',
        details: { fields: [{ path: 'about.en-AU', code: 'claim-term' }] },
      }),
    );
    fireEvent.click(save());
    await screen.findAllByText(/This text claims a certification/);
    expect(save().disabled).toBe(true);
  });
});

describe('StoreProfile About card', () => {
  it('shows the saved text and a counter, and the save bar only once something changed', () => {
    mount();
    expect(box().value).toBe('Family bakery.');
    expect(screen.getByText('14 of 2000 characters')).toBeTruthy();
    expect(screen.queryByRole('region', { name: 'Unsaved changes' })).toBeNull();
    fireEvent.change(box(), { target: { value: 'Family bakery, open daily.' } });
    expect(screen.getByRole('region', { name: 'Unsaved changes' }).textContent).toContain(
      '1 unsaved change',
    );
    expect(box().className).toContain('ring-attention-border');
    expect(save().disabled).toBe(false);
    fireEvent.click(screen.getByRole('button', { name: 'Discard' }));
    expect(box().value).toBe('Family bakery.');
    expect(screen.queryByRole('region', { name: 'Unsaved changes' })).toBeNull();
    expect(call).not.toHaveBeenCalled();
  });

  it('saves with the version it loaded, shows the saved line and takes the server text', async () => {
    mount();
    call.mockResolvedValueOnce(
      done(view({ version: 3, about: { 'en-AU': 'Family bakery, since 1990.' } })),
    );

    fireEvent.change(box(), { target: { value: '  Family bakery, since 1990.  ' } });
    fireEvent.click(save());

    await expectToast('Saved. Buyers can see it now.');
    expect(call).toHaveBeenCalledWith(
      'PUT',
      'sellers/store-profile',
      { expectedVersion: 2, about: { 'en-AU': '  Family bakery, since 1990.  ' } },
      'csrf',
    );
    expect(box().value).toBe('Family bakery, since 1990.');
    // Nothing is unsaved any more: the bar is gone.
    expect(screen.queryByRole('region', { name: 'Unsaved changes' })).toBeNull();
  });

  it('shows Saving… and ignores a second click while the save runs', async () => {
    mount();
    let finish: (value: ReturnType<typeof done>) => void = () => undefined;
    call.mockReturnValueOnce(new Promise((resolve) => (finish = resolve)));

    fireEvent.change(box(), { target: { value: 'New text' } });
    fireEvent.click(save());
    const saving = await screen.findByRole('button', { name: 'Saving…' });
    fireEvent.click(saving);
    finish(done(view({ version: 3, about: { 'en-AU': 'New text' } })));

    await expectToast('Saved. Buyers can see it now.');
    expect(call).toHaveBeenCalledTimes(1);
  });

  it('counts characters as people do and refuses a text over the limit before sending', () => {
    mount(view({ aboutMaxLength: 10 }));
    fireEvent.change(box(), { target: { value: '😀'.repeat(11) } });

    expect(screen.getByText('11 of 10 characters')).toBeTruthy();
    expect(screen.getByText('Use at most 10 characters.')).toBeTruthy();
    expect(save().disabled).toBe(true);
    expect(screen.getByRole('region', { name: 'Unsaved changes' }).textContent).toContain(
      '1 needs fixing',
    );
    // The error summary at the top links to the box.
    const summary = screen.getByRole('alert');
    expect(summary.textContent).toContain('1 setting needs fixing before you can save');
    expect(summary.textContent).toContain(': Use at most 10 characters.');
    fireEvent.click(within(summary).getByRole('link', { name: /About your store/ }));
    expect(document.activeElement).toBe(box());
    expect(box().getAttribute('aria-invalid')).toBe('true');
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
    fireEvent.click(save());

    await screen.findAllByText(/This text claims a certification/);
    // One announcement of the failure: the field's own alert, with no second banner above it.
    expect(screen.getAllByRole('alert')).toHaveLength(1);
    expect(box().getAttribute('aria-invalid')).toBe('true');
    expect(call).toHaveBeenCalledTimes(1);
  });

  it('keeps the drafts on a stale save, compares per locale, and sends the new version next', async () => {
    mount(
      view({
        locales: ['en-AU', 'ja'],
        about: { 'en-AU': 'Family bakery.', ja: '' },
      }),
    );
    const boxFor = (name: RegExp) => screen.getByRole<HTMLTextAreaElement>('textbox', { name });
    call
      .mockResolvedValueOnce(failure({ status: 409, code: 'conflict.stale' }))
      .mockResolvedValueOnce(
        done(
          view({
            version: 5,
            locales: ['en-AU', 'ja'],
            about: { 'en-AU': '<b>Their</b> text', ja: '' },
          }),
        ),
      )
      .mockResolvedValueOnce(
        done(
          view({
            version: 6,
            locales: ['en-AU', 'ja'],
            about: { 'en-AU': 'My edit', ja: 'Mine' },
          }),
        ),
      );
    fireEvent.change(boxFor(/English/), { target: { value: 'My edit' } });
    fireEvent.click(save());

    await screen.findByText('Someone else saved these settings first');
    expect(call).toHaveBeenNthCalledWith(2, 'GET', 'sellers/store-profile');
    // Both drafts stay in the boxes.
    expect(boxFor(/English/).value).toBe('My edit');
    fireEvent.change(boxFor(/Japanese/), { target: { value: 'Mine' } });

    fireEvent.click(screen.getByRole('button', { name: 'Compare' }));
    const english = compared(/^About your store \(.*English.*\)$/);
    expect(english).toMatchObject({ saved: '<b>Their</b> text', yours: 'My edit' });
    expect(english.item.querySelector('b')).toBeNull();
    expect(compared('About your store (Japanese)')).toMatchObject({
      saved: 'empty',
      yours: 'Mine',
    });
    expect(screen.getByRole('region', { name: 'Unsaved changes' }).textContent).toContain(
      '2 unsaved changes',
    );

    fireEvent.click(save());
    await waitFor(() => expect(call).toHaveBeenCalledTimes(3));
    expect(call).toHaveBeenNthCalledWith(
      3,
      'PUT',
      'sellers/store-profile',
      { expectedVersion: 5, about: { 'en-AU': 'My edit', ja: 'Mine' } },
      'csrf',
    );
    await waitFor(() =>
      expect(screen.queryByText('Someone else saved these settings first')).toBeNull(),
    );
  });

  it('says how long to wait when saves are throttled', async () => {
    mount();
    call.mockResolvedValueOnce(
      failure({ status: 429, code: 'request.throttled', details: { retryAfterSeconds: 12 } }),
    );
    fireEvent.change(box(), { target: { value: 'x' } });
    fireEvent.click(save());

    await screen.findByText('Too many saves. Wait 12 seconds and try again.');
  });

  it('shows an unavailable message when the service is down, and keeps the text', async () => {
    mount();
    call.mockResolvedValueOnce(failure({ status: 503, code: 'sellers.unavailable' }));
    fireEvent.change(box(), { target: { value: 'Kept' } });
    fireEvent.click(save());

    await screen.findByText('The store profile is unavailable right now. Try again later.');
    expect(box().value).toBe('Kept');
  });

  it('sends a signed-out seller to the session-ended page', async () => {
    const assign = vi.fn();
    vi.stubGlobal('location', { ...window.location, assign });
    mount();
    call.mockResolvedValueOnce(failure({ status: 401, code: 'session.invalid' }));
    fireEvent.change(box(), { target: { value: 'x' } });
    fireEvent.click(save());

    await waitFor(() => expect(assign).toHaveBeenCalledWith('/session-ended'));
    vi.unstubAllGlobals();
  });

  it('offers one box per locale of the Market, named by language', () => {
    mount(view({ locales: ['ja-JP', 'en-US'], about: { 'ja-JP': 'こんにちは', 'en-US': '' } }));

    expect(screen.getByRole('textbox', { name: /About your store \(Japanese/ })).toBeTruthy();
    expect(
      screen.getByRole('textbox', { name: /About your store \(United States English/ }),
    ).toBeTruthy();
  });
});

describe('StoreProfile pictures', () => {
  const file = () => new File([new Uint8Array([1, 2, 3])], 'logo.png', { type: 'image/png' });
  const row = (name: string) => screen.getByRole<HTMLElement>('group', { name });
  const chooseIn = (name: string) =>
    row(name).querySelector('input[type=file]') as HTMLInputElement;
  const SAVED = { id: IMAGE, width: 512, height: 512 };
  const WIDE = { id: IMAGE, width: 1536, height: 384 };
  const pick = async (name: string, data = 'QUJD') => {
    prepare.mockResolvedValueOnce({ kind: 'ready', data });
    fireEvent.change(chooseIn(name), { target: { files: [file()] } });
    await waitFor(() => expect(within(row(name)).getByRole('img')).toBeTruthy());
  };

  it('has a Pictures section with a Logo and a Banner row, and the spec help text', () => {
    mount();
    expect(screen.getByRole('heading', { name: 'Pictures' })).toBeTruthy();
    expect(screen.getByText('JPEG, PNG or WebP, under 25 MB.')).toBeTruthy();
    expect(within(row('Logo')).getByText('No logo')).toBeTruthy();
    expect(within(row('Banner')).getByText('No banner')).toBeTruthy();
    expect(within(row('Logo')).getByText('Choose a picture')).toBeTruthy();
    expect(within(row('Logo')).queryByRole('button', { name: 'Remove' })).toBeNull();
  });

  it('shows the saved pictures', () => {
    mount(view({ logo: SAVED, banner: WIDE }));
    expect(
      within(row('Logo')).getByRole('img', { name: 'Your store logo' }).getAttribute('src'),
    ).toBe(`/api/sellers/store-profile/images/${IMAGE}/small`);
    expect(
      within(row('Banner')).getByRole('img', { name: 'Your store banner' }).getAttribute('src'),
    ).toBe(`/api/sellers/store-profile/images/${IMAGE}/large`);
    expect(screen.queryByRole('region', { name: 'Unsaved changes' })).toBeNull();
  });

  it('stages a chosen picture with a preview and does not call the server', async () => {
    mount();
    await pick('Banner');

    expect(within(row('Banner')).getByRole('img').getAttribute('src')).toBe(
      'data:image/jpeg;base64,QUJD',
    );
    expect(screen.getByRole('region', { name: 'Unsaved changes' }).textContent).toContain(
      '1 unsaved change',
    );
    expect(within(row('Banner')).getByText('Replace')).toBeTruthy();
    expect(call).not.toHaveBeenCalled();
    expect(screen.getByText('No logo')).toBeTruthy();
  });

  it('saves a picture and the text in one versioned call, with one toast', async () => {
    mount(view({ logo: SAVED }));
    await pick('Banner');
    fireEvent.click(within(row('Logo')).getByRole('button', { name: 'Remove' }));
    fireEvent.change(box(), { target: { value: 'New text' } });
    call.mockResolvedValueOnce(
      done(view({ version: 3, about: { 'en-AU': 'New text' }, banner: WIDE })),
    );

    expect(screen.getByRole('region', { name: 'Unsaved changes' }).textContent).toContain(
      '3 unsaved changes',
    );
    fireEvent.click(save());

    await expectToast('Saved. Buyers can see it now.');
    expect(call).toHaveBeenCalledTimes(1);
    expect(call).toHaveBeenCalledWith(
      'PUT',
      'sellers/store-profile',
      { expectedVersion: 2, about: { 'en-AU': 'New text' }, logo: null, banner: { data: 'QUJD' } },
      'csrf',
    );
    expect(screen.queryByRole('region', { name: 'Unsaved changes' })).toBeNull();
    expect(within(row('Banner')).getByRole('img').getAttribute('src')).toBe(
      `/api/sellers/store-profile/images/${IMAGE}/large`,
    );
    expect(within(row('Logo')).getByText('No logo')).toBeTruthy();
  });

  it('saves a picture change alone', async () => {
    mount();
    await pick('Logo');
    call.mockResolvedValueOnce(done(view({ version: 3, logo: SAVED })));
    fireEvent.click(save());
    await expectToast('Saved. Buyers can see it now.');
    expect(call).toHaveBeenCalledWith(
      'PUT',
      'sellers/store-profile',
      { expectedVersion: 2, about: { 'en-AU': 'Family bakery.' }, logo: { data: 'QUJD' } },
      'csrf',
    );
  });

  it('puts the saved picture back on Discard', () => {
    mount(view({ logo: SAVED }));
    fireEvent.click(within(row('Logo')).getByRole('button', { name: 'Remove' }));
    expect(within(row('Logo')).getByText('No logo')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Discard' }));

    expect(within(row('Logo')).getByRole('img', { name: 'Your store logo' })).toBeTruthy();
    expect(screen.queryByRole('region', { name: 'Unsaved changes' })).toBeNull();
    expect(call).not.toHaveBeenCalled();
  });

  it('takes a staged picture back when it is removed and none was saved', async () => {
    mount();
    await pick('Logo');
    fireEvent.click(within(row('Logo')).getByRole('button', { name: 'Remove' }));

    expect(within(row('Logo')).getByText('No logo')).toBeTruthy();
    expect(screen.queryByRole('region', { name: 'Unsaved changes' })).toBeNull();
  });

  it('lists a picture change in the comparison after a stale save', async () => {
    mount(view({ logo: SAVED }));
    fireEvent.click(within(row('Logo')).getByRole('button', { name: 'Remove' }));
    call
      .mockResolvedValueOnce(failure({ status: 409, code: 'conflict.stale' }))
      .mockResolvedValueOnce(done(view({ version: 5, logo: SAVED })));
    fireEvent.click(save());

    await screen.findByText('Someone else saved these settings first');
    fireEvent.click(screen.getByRole('button', { name: 'Compare' }));
    expect(compared('Logo')).toMatchObject({ saved: 'Current picture', yours: 'Removed' });
  });

  it('moves focus to the picker after Remove', () => {
    mount(view({ logo: SAVED }));
    fireEvent.click(within(row('Logo')).getByRole('button', { name: 'Remove' }));
    expect(document.activeElement).toBe(chooseIn('Logo'));
  });

  it('disables the pickers and shows Saving… while the save runs', async () => {
    mount();
    await pick('Logo');
    let finish: (value: ReturnType<typeof done>) => void = () => undefined;
    call.mockReturnValueOnce(new Promise((resolve) => (finish = resolve)));
    fireEvent.click(save());

    await screen.findByRole('button', { name: 'Saving…' });
    expect(chooseIn('Logo').disabled).toBe(true);
    expect(chooseIn('Banner').disabled).toBe(true);
    finish(done(view({ version: 3, logo: SAVED })));
    await expectToast('Saved. Buyers can see it now.');
  });

  it('says so, and stages nothing, when the browser cannot take the file', async () => {
    mount();
    prepare.mockResolvedValueOnce({ kind: 'refused', reason: 'too-large' });
    fireEvent.change(chooseIn('Banner'), { target: { files: [file()] } });

    await within(row('Banner')).findByText('That picture is too large. Choose one under 25 MB.');
    expect(screen.queryByRole('region', { name: 'Unsaved changes' })).toBeNull();
    expect(call).not.toHaveBeenCalled();
    // A refused file does not keep the page from saving; the next pick clears the notice.
    await pick('Banner');
    expect(within(row('Banner')).queryByRole('alert')).toBeNull();
  });

  it.each([
    ['file.too-small', 'logo', 422, 'That logo is too small. Use at least 128 × 128 px.'],
    ['file.too-small', 'banner', 422, 'That banner is too small. Use at least 1200 × 300 px.'],
    ['file.unsupported-type', 'logo', 415, 'That file is not a JPEG, PNG or WebP picture.'],
    [
      'file.too-many-pixels',
      'logo',
      422,
      'That picture has too many pixels. Choose a smaller one.',
    ],
    ['file.unreadable', 'logo', 422, 'We could not read that picture. Try another file.'],
  ])(
    'shows %s for the %s on its own row, blocks Save, and clears on a new pick',
    async (code, kind, status, message) => {
      mount();
      const name = kind === 'logo' ? 'Logo' : 'Banner';
      await pick(name);
      call.mockResolvedValueOnce(
        failure({ status, code, details: { kind: kind as 'logo' | 'banner' } }),
      );
      fireEvent.click(save());

      await within(row(name)).findByText(message);
      expect(screen.getByRole('alert').textContent).toContain(
        '1 setting needs fixing before you can save',
      );
      expect(save().disabled).toBe(true);
      // The other row is untouched.
      expect(within(row(name === 'Logo' ? 'Banner' : 'Logo')).queryByText(message)).toBeNull();

      await pick(name, 'REVG');
      expect(within(row(name)).queryByText(message)).toBeNull();
      expect(save().disabled).toBe(false);
    },
  );

  it('shows the unavailable message and keeps the staged picture', async () => {
    mount();
    await pick('Logo');
    call.mockResolvedValueOnce(failure({ status: 503, code: 'sellers.unavailable' }));
    fireEvent.click(save());

    await screen.findByText('The store profile is unavailable right now. Try again later.');
    expect(within(row('Logo')).getByRole('img').getAttribute('src')).toContain('QUJD');
    expect(save().disabled).toBe(false);
  });

  it('keeps an empty status region in each picture row from the start', () => {
    mount();
    for (const name of ['Logo', 'Banner']) {
      expect(within(row(name)).getByRole('status').textContent).toBe('');
    }
  });
});

describe('StoreProfile without the edit permission', () => {
  it('shows the view-only banner and the content, with no way to change it', () => {
    mount(view({ logo: { id: IMAGE, width: 512, height: 512 }, banner: null }), false);

    expect(screen.getByText(/You can see the store profile but not change it/)).toBeTruthy();
    expect(box().disabled).toBe(true);
    expect(box().value).toBe('Family bakery.');
    expect(screen.queryByRole('button', { name: 'Save changes' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Remove' })).toBeNull();
    expect(document.querySelector('input[type=file]')).toBeNull();
    expect(screen.getByRole('img', { name: 'Your store logo' })).toBeTruthy();
  });
});

describe('problem mapping', () => {
  it('maps a refused picture to its kind, and anything else to the About problem', () => {
    expect(
      saveProblemOf({ status: 422, code: 'file.too-small', details: { kind: 'banner' } }),
    ).toEqual({
      banner: null,
      fields: {},
      pictures: { banner: { key: 'too-small.banner' } },
    });
    expect(saveProblemOf({ status: 409, code: 'conflict.stale' })).toMatchObject({
      banner: 'stale',
      pictures: {},
    });
  });

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
