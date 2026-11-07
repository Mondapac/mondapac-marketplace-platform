// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { NextIntlClientProvider } from 'next-intl';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import messages from '../../../messages/en.json';

vi.mock('../../api/client.ts', () => ({ callApi: vi.fn() }));
vi.mock('../photo-prepare.ts', () => ({ preparePhoto: vi.fn() }));

import { callApi } from '../../api/client.ts';
import { preparePhoto } from '../photo-prepare.ts';
import { PhotoStep, leftText } from './photo-step.tsx';
import { buildZip, JPEG, PNG, WEBP, zipFile } from './zip-fixture.ts';
import type { ZipErrorCode } from './zip-reader.ts';
import { classifyPhotoFailure, pickPhotos, runPhotoQueue } from './photo-queue.ts';

const call = vi.mocked(callApi);
const prepare = vi.mocked(preparePhoto);
const ID = '0190a000-0000-7000-8000-000000000001';
const URL_OF = `catalog/seller/imports/${ID}/photos`;

const jpg = (name: string) => new File(['x'], name, { type: 'image/jpeg' });
const ok = () =>
  Promise.resolve({
    ok: true,
    status: 201,
    body: { productId: 'p', image: { imageId: 'i', width: 1, height: 1, createdAt: 'now' } },
  } as never);
const fail = (status: number, code: string, details?: object) =>
  Promise.resolve({
    ok: false,
    failure: { status, code, ...(details ? { details } : {}) },
  } as never);

function pick(label: string, files: File[]) {
  fireEvent.change(screen.getByLabelText(label), { target: { files } });
}

const mount = (clock: () => number = Date.now) =>
  render(
    <NextIntlClientProvider locale="en-AU" messages={messages}>
      <PhotoStep importId={ID} csrfToken="csrf-1" now={clock} minIntervalMs={0} />
    </NextIntlClientProvider>,
  );

beforeEach(() => {
  vi.clearAllMocks();
  prepare.mockResolvedValue({ kind: 'ready', data: 'QUJD' });
});
afterEach(cleanup);

describe('picking photos', () => {
  it('keeps pictures only and the first of each name without case, and counts what is left out', () => {
    const picked = pickPhotos([
      jpg('A.jpg'),
      jpg('a.JPG'),
      jpg('b.png'),
      new File(['x'], 'notes.txt'),
      jpg('c.webp'),
    ]);
    expect(picked.items.map((item) => item.name)).toEqual(['A.jpg', 'b.png', 'c.webp']);
    expect(picked.notPhotos).toBe(1);
    expect(picked.sameName).toBe(1);
  });

  it('takes no more than 2,000 photos in one picking', () => {
    const many = Array.from({ length: 2003 }, (_, index) => jpg(`p${index}.jpg`));
    const picked = pickPhotos(many);
    expect(picked.items).toHaveLength(2000);
    expect(picked.overLimit).toBe(3);
  });

  it('offers a multi-file picker and a folder picker, and a folder pick feeds the same queue', () => {
    mount();
    const files = screen.getByLabelText<HTMLInputElement>('Choose photos');
    const folder = screen.getByLabelText<HTMLInputElement>('Choose a folder');
    expect(files.multiple).toBe(true);
    expect(files.hasAttribute('webkitdirectory')).toBe(false);
    expect(folder.multiple).toBe(true);
    expect(folder.hasAttribute('webkitdirectory')).toBe(true);
    pick('Choose a folder', [jpg('x.jpg'), new File(['x'], 'readme.md')]);
    expect(screen.getByText('1 photo ready to send')).toBeTruthy();
    expect(
      screen.getByText(/Left out: 1 file that is not a JPEG, PNG or WebP picture/),
    ).toBeTruthy();
  });

  it('prints counts of 1,000 or more in the left-out line', () => {
    mount();
    const junk = Array.from({ length: 1200 }, (_, index) => new File(['x'], `n${index}.txt`));
    pick('Choose photos', [jpg('a.jpg'), ...junk]);
    expect(
      screen.getByText(/Left out: 1,200 files that are not JPEG, PNG or WebP pictures/),
    ).toBeTruthy();
    expect(document.body.textContent).not.toContain('NaN');
  });

  it('shows long waits in minutes or hours', () => {
    const words = (key: string, v: Record<string, number>) => `${key}:${JSON.stringify(v)}`;
    expect(leftText(30_000, words)).toBe('throttled-seconds:{"n":30}');
    expect(leftText(300_000, words)).toBe('throttled-minutes:{"n":5}');
    expect(leftText(5_400_000 + 1_800_000, words)).toBe('throttled-hours:{"h":2,"m":0}');
  });

  it('offers a single-file ZIP picker next to the others', () => {
    mount();
    const zip = screen.getByLabelText<HTMLInputElement>('Choose a ZIP file');
    expect(zip.multiple).toBe(false);
    expect(zip.hasAttribute('webkitdirectory')).toBe(false);
    expect(zip.getAttribute('accept')).toContain('.zip');
    expect(screen.getByText(/Have your photos in one ZIP file\?/)).toBeTruthy();
  });
});

describe('a ZIP of photos', () => {
  const zipOf = (entries: Parameters<typeof buildZip>[0]) => zipFile(buildZip(entries));

  it('flows into the same list and the same requests as picked files', async () => {
    call.mockImplementation(() => ok());
    mount();
    pick('Choose a ZIP file', [
      zipOf([
        { name: 'shop/dates-500g.jpg', data: JPEG(30) },
        { name: 'shop/honey.png', data: PNG(), method: 0 },
        { name: '__MACOSX/shop/._honey.png', data: new Uint8Array([1]) },
      ]),
    ]);
    expect(await screen.findByText('2 photos ready to send')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Upload 2 photos' }));
    expect(await screen.findByText('2 photos added')).toBeTruthy();
    expect(call.mock.calls.map((c) => (c[2] as { name: string }).name)).toEqual([
      'dates-500g.jpg',
      'honey.png',
    ]);
    // Each one went through the browser's photo preparation, as a picked file does.
    expect(prepare).toHaveBeenCalledTimes(2);
    expect(prepare.mock.calls.map((c) => c[0].name)).toEqual(['dates-500g.jpg', 'honey.png']);
    for (const url of call.mock.calls.map((c) => c[1])) expect(url).toBe(URL_OF);
  });

  it('shares the duplicate and left-out rules with picking: names already picked are replaced by the ZIP', async () => {
    mount();
    pick('Choose photos', [jpg('old.jpg')]);
    expect(screen.getByText('1 photo ready to send')).toBeTruthy();
    pick('Choose a ZIP file', [
      zipOf([
        { name: 'a.jpg', data: JPEG() },
        { name: 'b.webp', data: WEBP() },
      ]),
    ]);
    expect(await screen.findByText('2 photos ready to send')).toBeTruthy();
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('says why a ZIP is refused, names the file, and sends nothing', async () => {
    mount();
    pick('Choose a ZIP file', [
      zipOf([
        { name: 'x/a.jpg', data: JPEG() },
        { name: 'y/A.jpg', data: JPEG(3) },
      ]),
    ]);
    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toContain(
      'Two files in the ZIP file are both called A.jpg. Every photo needs its own file name.',
    );
    expect(screen.getByText('The ZIP file can’t be used')).toBeTruthy();
    expect(screen.queryByRole('button', { name: /Upload/ })).toBeNull();
    expect(call).not.toHaveBeenCalled();
  });

  it('leaves out what is not a picture or is too big, and says so in the left-out line', async () => {
    mount();
    pick('Choose a ZIP file', [
      zipOf([
        { name: 'a.jpg', data: JPEG() },
        { name: 'Thumbs.db', data: new Uint8Array([1]) },
        { name: 'list.csv', data: new Uint8Array([2]) },
        { name: 'huge.jpg', data: JPEG(), declaredSize: 30 * 1024 * 1024 },
      ]),
    ]);
    expect(await screen.findByText('1 photo ready to send')).toBeTruthy();
    const left = screen.getByText(/^Left out:/).textContent ?? '';
    expect(left).toContain('2 files that are not JPEG, PNG or WebP pictures.');
    expect(left).toContain('1 photo in the ZIP file over 25 MB.');
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('shows that it is opening, disables the pickers, and moves focus to Cancel', async () => {
    mount();
    const zipInput = screen.getByLabelText<HTMLInputElement>('Choose a ZIP file');
    zipInput.focus();
    pick('Choose a ZIP file', [zipOf([{ name: 'a.jpg', data: JPEG() }])]);
    const status = screen.getAllByRole('status').find((el) => /Opening/.test(el.textContent ?? ''));
    expect(status?.textContent).toBe('Opening your ZIP file…');
    for (const label of ['Choose photos', 'Choose a folder', 'Choose a ZIP file']) {
      expect(screen.getByLabelText<HTMLInputElement>(label).disabled).toBe(true);
    }
    const cancel = screen.getByRole('button', { name: 'Cancel' });
    expect(document.activeElement).toBe(cancel);
    expect(await screen.findByText('1 photo ready to send')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Cancel' })).toBeNull();
    expect(screen.getByLabelText<HTMLInputElement>('Choose photos').disabled).toBe(false);
  });

  it('cancels a long unzip without a message and keeps the earlier picking', async () => {
    mount();
    pick('Choose photos', [jpg('old.jpg')]);
    pick('Choose a ZIP file', [zipOf([{ name: 'a.jpg', data: JPEG() }])]);
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    await waitFor(() => expect(screen.queryByRole('button', { name: 'Cancel' })).toBeNull());
    expect(screen.getByText('1 photo ready to send')).toBeTruthy();
    expect(screen.queryByRole('alert')).toBeNull();
    expect(screen.getByLabelText<HTMLInputElement>('Choose a ZIP file').disabled).toBe(false);
  });

  it('has one message for every refusal code', () => {
    const codes: ZipErrorCode[] = [
      'too-big',
      'total-too-big',
      'too-many-entries',
      'unsupported-compression',
      'encrypted',
      'zip64',
      'multi-disk',
      'broken',
      'duplicate-name',
      'unsupported-browser',
    ];
    expect(Object.keys(messages.catalog.import.photos.zip.errors).sort()).toEqual(
      [...codes].sort(),
    );
  });

  it('words a damaged file and clears the message on the next pick', async () => {
    mount();
    pick('Choose a ZIP file', [
      zipFile(new TextEncoder().encode('not a zip, only some words in a file')),
    ]);
    expect((await screen.findByRole('alert')).textContent).toMatch(/damaged or isn’t a ZIP file/);
    pick('Choose photos', [jpg('a.jpg')]);
    expect(screen.queryByRole('alert')).toBeNull();
  });
});

describe('sending photos', () => {
  it('sends each named photo as its own request, in order, with the name and the CSRF token', async () => {
    call.mockImplementation(() => ok());
    mount();
    pick('Choose photos', [jpg('one.jpg'), jpg('two.jpg')]);
    fireEvent.click(screen.getByRole('button', { name: 'Upload 2 photos' }));
    expect(await screen.findByText('2 photos added')).toBeTruthy();
    expect(call).toHaveBeenCalledTimes(2);
    expect(call).toHaveBeenNthCalledWith(
      1,
      'POST',
      URL_OF,
      { name: 'one.jpg', data: 'QUJD' },
      'csrf-1',
    );
    expect(call).toHaveBeenNthCalledWith(
      2,
      'POST',
      URL_OF,
      { name: 'two.jpg', data: 'QUJD' },
      'csrf-1',
    );
  });

  it('never has two requests in flight', async () => {
    let open = 0;
    let most = 0;
    call.mockImplementation(async () => {
      open += 1;
      most = Math.max(most, open);
      await new Promise((resolve) => setTimeout(resolve, 5));
      open -= 1;
      return ok();
    });
    mount();
    pick('Choose photos', [jpg('a.jpg'), jpg('b.jpg'), jpg('c.jpg')]);
    fireEvent.click(screen.getByRole('button', { name: 'Upload 3 photos' }));
    await screen.findByText('3 photos added');
    expect(most).toBe(1);
  });

  it('goes on after a photo the file does not name, an eighth-photo limit and a duplicate', async () => {
    const codes = ['import.photo-not-named', 'image.limit-reached', 'import.photo-already-added'];
    let index = 0;
    call.mockImplementation(() => {
      const code = codes[index];
      index += 1;
      return code === undefined ? ok() : fail(422, code);
    });
    mount();
    pick('Choose photos', [jpg('a.jpg'), jpg('b.jpg'), jpg('c.jpg'), jpg('d.jpg')]);
    fireEvent.click(screen.getByRole('button', { name: 'Upload 4 photos' }));
    expect(await screen.findByText('1 photo added')).toBeTruthy();
    expect(call).toHaveBeenCalledTimes(4);
    expect(
      screen.getByText('Your file doesn’t list this name. Check the Images column.'),
    ).toBeTruthy();
    expect(screen.getByText('The product already has eight photos.')).toBeTruthy();
    expect(screen.getByText('A photo with this name was already added.')).toBeTruthy();
  });

  it('words a photo the browser or the server cannot use', async () => {
    prepare.mockResolvedValueOnce({ kind: 'refused', reason: 'unreadable' });
    call.mockImplementationOnce(() => fail(422, 'file.too-small'));
    mount();
    pick('Choose photos', [jpg('bad.jpg'), jpg('tiny.jpg')]);
    fireEvent.click(screen.getByRole('button', { name: 'Upload 2 photos' }));
    await waitFor(() => expect(screen.getAllByText(/The picture can’t be used/)).toHaveLength(2));
    // The unreadable one never reached the server.
    expect(call).toHaveBeenCalledTimes(1);
  });

  it('stops on a throttle, shows when to go on, and continues with the rest after the wait', async () => {
    let clock = Date.UTC(2026, 10, 7, 10, 0, 0);
    let throttled = true;
    call.mockImplementation((_m, _p, body) => {
      const name = (body as { name: string }).name;
      if (name === 'b.jpg' && throttled)
        return fail(429, 'request.throttled', { retryAfterSeconds: 90 });
      return ok();
    });
    mount(() => clock);
    pick('Choose photos', [jpg('a.jpg'), jpg('b.jpg'), jpg('c.jpg')]);
    fireEvent.click(screen.getByRole('button', { name: 'Upload 3 photos' }));
    expect(await screen.findByText('Too many photos for now')).toBeTruthy();
    // a was sent, b was refused, c was never tried.
    expect(call).toHaveBeenCalledTimes(2);
    expect(screen.getByText(/You can go on at/)).toBeTruthy();
    expect(screen.getByText('90 seconds left')).toBeTruthy();
    const wait = screen.getByRole('button', { name: 'Continue with 2 photos' });
    expect(wait).toHaveProperty('disabled', true);

    throttled = false;
    clock += 91_000;
    await waitFor(
      () =>
        expect(screen.getByRole('button', { name: 'Continue with 2 photos' })).toHaveProperty(
          'disabled',
          false,
        ),
      { timeout: 2500 },
    );
    expect(screen.getByText('You can go on now.')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Continue with 2 photos' }));
    expect(await screen.findByText('3 photos added')).toBeTruthy();
    expect(call).toHaveBeenCalledTimes(4);
  });

  it('stops for good when the photo step is closed, and when access is lost', async () => {
    call.mockImplementation(() => fail(409, 'import.photos-closed'));
    mount();
    pick('Choose photos', [jpg('a.jpg'), jpg('b.jpg')]);
    fireEvent.click(screen.getByRole('button', { name: 'Upload 2 photos' }));
    expect(await screen.findByText('The photo step is over')).toBeTruthy();
    expect(call).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole('button', { name: /Continue/ })).toBeNull();
    cleanup();
    call.mockClear();
    call.mockImplementation(() => fail(403, 'access.denied'));
    mount();
    pick('Choose photos', [jpg('a.jpg')]);
    fireEvent.click(screen.getByRole('button', { name: 'Upload 1 photo' }));
    expect(await screen.findByText('You can’t add photos right now')).toBeTruthy();
    expect(screen.queryByRole('button', { name: /Continue/ })).toBeNull();
  });

  it('keeps the rest for another try when the server does not answer', async () => {
    call.mockImplementationOnce(() => ok());
    call.mockImplementationOnce(() => fail(503, 'access.unavailable'));
    mount();
    pick('Choose photos', [jpg('a.jpg'), jpg('b.jpg')]);
    fireEvent.click(screen.getByRole('button', { name: 'Upload 2 photos' }));
    expect(await screen.findByText('The upload was interrupted')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Continue with 1 photo' })).toHaveProperty(
      'disabled',
      false,
    );
  });

  it('stops between photos when the seller presses Stop, and can continue', async () => {
    let release: (() => void) | undefined;
    call.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          release = () => resolve({ ok: true, status: 201, body: {} } as never);
        }),
    );
    call.mockImplementation(() => ok());
    mount();
    pick('Choose photos', [jpg('a.jpg'), jpg('b.jpg')]);
    fireEvent.click(screen.getByRole('button', { name: 'Upload 2 photos' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Stop' }));
    act(() => {
      release?.();
    });
    expect(await screen.findByRole('button', { name: 'Continue with 1 photo' })).toBeTruthy();
    expect(call).toHaveBeenCalledTimes(1);
  });

  it('shows the progress bar and a status line while it works', async () => {
    call.mockImplementation(() => ok());
    mount();
    pick('Choose photos', [jpg('a.jpg')]);
    fireEvent.click(screen.getByRole('button', { name: 'Upload 1 photo' }));
    await screen.findByText('1 photo added');
    const meter = screen.getByRole('progressbar', { name: 'Photo upload progress' });
    expect(meter.getAttribute('aria-valuenow')).toBe('100');
    expect(within(document.body).getByText('1 of 1 photos done')).toBeTruthy();
  });
});

describe('classifying a refusal', () => {
  it('stops the queue only for a throttle, a closed step, access and an unreachable server', () => {
    const stops = [
      ['request.throttled', 'throttled'],
      ['import.photos-closed', 'closed'],
      ['import.not-found', 'closed'],
      ['access.denied', 'access'],
      ['seller.not-eligible', 'access'],
      ['request.csrf', 'access'],
      ['access.unavailable', 'unavailable'],
      ['network', 'unavailable'],
    ] as const;
    for (const [code, kind] of stops) {
      const sorted = classifyPhotoFailure('a.jpg', { status: 400, code });
      expect('stop' in sorted && sorted.stop.kind, code).toBe(kind);
    }
    const results = [
      ['import.photo-not-named', 'not-named'],
      ['import.photo-already-added', 'already'],
      ['image.limit-reached', 'limit'],
      ['file.too-large', 'refused'],
      ['file.too-many-pixels', 'refused'],
      ['product.not-found', 'product-gone'],
    ] as const;
    for (const [code, outcome] of results) {
      const sorted = classifyPhotoFailure('a.jpg', { status: 422, code });
      expect('result' in sorted && sorted.result.outcome, code).toBe(outcome);
    }
  });

  it('reads the wait from retryAfterSeconds and falls back to a minute', () => {
    const wait = (details?: { retryAfterSeconds: number }) => {
      const sorted = classifyPhotoFailure('a.jpg', {
        status: 429,
        code: 'request.throttled',
        ...(details ? { details } : {}),
      });
      return 'stop' in sorted && sorted.stop.kind === 'throttled'
        ? sorted.stop.retryAfterSeconds
        : null;
    };
    expect(wait({ retryAfterSeconds: 90.2 })).toBe(91);
    expect(wait()).toBe(60);
  });
});

describe('the queue keeps below the per-minute limit', () => {
  it('leaves at least the minimum interval between two requests', async () => {
    let clock = 0;
    const slept: number[] = [];
    call.mockImplementation(() => {
      clock += 100;
      return ok();
    });
    const end = await runPhotoQueue(
      [
        { name: 'a.jpg', file: jpg('a.jpg') },
        { name: 'b.jpg', file: jpg('b.jpg') },
      ],
      {
        importId: ID,
        csrfToken: 'x',
        onResult: () => undefined,
        cancelled: () => false,
        now: () => clock,
        sleep: (ms) => {
          slept.push(ms);
          clock += ms;
          return Promise.resolve();
        },
        minIntervalMs: 1000,
      },
    );
    expect(end.stop).toBeNull();
    expect(slept).toEqual([900]);
  });
});
