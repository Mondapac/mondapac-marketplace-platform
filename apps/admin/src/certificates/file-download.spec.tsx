// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { NextIntlClientProvider } from 'next-intl';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import messages from '../../messages/en.json';
import { FileDownload } from './file-download.tsx';

const mocks = vi.hoisted(() => ({ save: vi.fn() }));

vi.mock('@mondapac/ui', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  saveFile: mocks.save,
}));

const PATH = 'certification/admin/seller-certificates/c1/documents/d1';

function show() {
  render(
    <NextIntlClientProvider locale="en-AU" messages={messages}>
      <FileDownload path={PATH} n={2} />
    </NextIntlClientProvider>,
  );
  fireEvent.click(screen.getByRole('button', { name: 'Download file 2' }));
}

function answer(status: number, body: BodyInit | null, headers: Record<string, string> = {}) {
  const fetchMock = vi.fn(() => Promise.resolve(new Response(body, { status, headers })));
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

describe('FileDownload', () => {
  beforeEach(() => mocks.save.mockReset());
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it('reads the file through the relay and saves it under the server name', async () => {
    const fetchMock = answer(200, new Uint8Array([1, 2, 3]), {
      'content-type': 'application/octet-stream',
      'content-disposition': 'attachment; filename="../certificate-d1.pdf"',
    });
    show();
    await waitFor(() => expect(mocks.save).toHaveBeenCalledTimes(1));
    expect(fetchMock).toHaveBeenCalledWith(`/api/${PATH}`, expect.anything());
    expect(mocks.save.mock.calls[0]?.[1]).toBe('..certificate-d1.pdf');
  });

  it('says so when file downloads are switched off', async () => {
    answer(403, JSON.stringify({ code: 'document.download-disabled' }), {
      'content-type': 'application/json',
    });
    show();
    await screen.findByText('Downloading files is switched off.');
    expect(mocks.save).not.toHaveBeenCalled();
  });

  it('words a refusal, a missing file and an outage apart', async () => {
    answer(403, JSON.stringify({ code: 'access.denied' }));
    show();
    await screen.findByText('You may not download this file.');
    cleanup();
    answer(404, JSON.stringify({ code: 'document.not-found' }));
    show();
    await screen.findByText('This file is no longer available.');
    cleanup();
    answer(503, null);
    show();
    await screen.findByText('The file could not be downloaded. Try again.');
    expect(mocks.save).not.toHaveBeenCalled();
  });

  it('does not save an answer that is not the attachment', async () => {
    answer(200, '<html></html>', { 'content-type': 'text/html' });
    show();
    await screen.findByText('The file could not be downloaded. Try again.');
    expect(mocks.save).not.toHaveBeenCalled();
  });
});
