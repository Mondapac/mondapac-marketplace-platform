// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { downloadReport, ReportDownloadError, safeFileName } from './report-download.ts';

const fetchMock = vi.fn<typeof fetch>();
const save = vi.fn();

beforeEach(() => {
  vi.stubGlobal('fetch', fetchMock);
  vi.stubGlobal(
    'URL',
    Object.assign(URL, {
      createObjectURL: (blob: Blob) => {
        save(blob);
        return 'blob:x';
      },
      revokeObjectURL: () => undefined,
    }),
  );
});
afterEach(() => {
  vi.unstubAllGlobals();
  fetchMock.mockReset();
  save.mockReset();
});

const input = {
  path: 'reporting/x/daily/export',
  query: 'period=7d&format=csv',
  format: 'csv',
  fallbackName: 'daily',
  zone: 'UTC',
} as const;
const failure = async (promise: Promise<unknown>) =>
  promise.then(
    () => null,
    (error: unknown) => (error instanceof ReportDownloadError ? error.reason : 'other'),
  );

describe('downloadReport', () => {
  it('asks the relay and saves a file of the asked type', async () => {
    fetchMock.mockResolvedValue(
      new Response('a,b\n', { headers: { 'content-type': 'text/csv; charset=utf-8' } }),
    );
    await downloadReport(input);
    expect(fetchMock.mock.calls[0]![0]).toBe('/api/reporting/x/daily/export?period=7d&format=csv');
    expect(save).toHaveBeenCalledTimes(1);
    // A redirect is never followed to another address.
    expect((fetchMock.mock.calls[0]![1] as RequestInit).redirect).toBe('error');
  });

  it('maps 401 and 403 to denied, 400 to invalid and the rest to unavailable', async () => {
    for (const [status, reason] of [
      [401, 'denied'],
      [403, 'denied'],
      [400, 'invalid'],
      [500, 'unavailable'],
    ] as const) {
      fetchMock.mockResolvedValueOnce(new Response('{}', { status }));
      expect(await failure(downloadReport(input))).toBe(reason);
    }
    fetchMock.mockRejectedValueOnce(new Error('offline'));
    expect(await failure(downloadReport(input))).toBe('unavailable');
  });

  it('does not save a response that is not the file asked for', async () => {
    fetchMock.mockResolvedValue(
      new Response('<html>', { headers: { 'content-type': 'text/html' } }),
    );
    expect(await failure(downloadReport(input))).toBe('unavailable');
    expect(save).not.toHaveBeenCalled();
  });

  it('keeps only safe characters of a file name', () => {
    expect(safeFileName('../../sales daily-2026.csv')).toBe('salesdaily-2026.csv');
    expect(safeFileName('../x/y.csv')).toBe('xy.csv');
  });
});
