// @vitest-environment jsdom
import { cleanup, render, screen } from '@testing-library/react';
import { createTranslator } from 'next-intl';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import messages from '../../messages/en.json';
import { CertificatesTabs } from './tabs.tsx';

const mocks = vi.hoisted(() => ({ get: vi.fn() }));

vi.mock('next-intl/server', () => ({
  getTranslations: (namespace: 'certificates.tabs') =>
    Promise.resolve(createTranslator({ locale: 'en-AU', messages, namespace })),
}));
vi.mock('../server/server-fetch.ts', () => ({ serverGet: mocks.get }));

const ALL = [
  'certification.seller-certificate.view',
  'certification.issuer.view',
  'certification.type.view',
];

async function show(keys: readonly string[], requestCount?: number) {
  render(
    await CertificatesTabs({
      active: 'queue',
      permissionKeys: keys,
      ...(requestCount === undefined ? {} : { requestCount }),
    }),
  );
}

describe('CertificatesTabs request count', () => {
  beforeEach(() => mocks.get.mockReset());
  afterEach(cleanup);

  it('shows the number of open requests on the tab', async () => {
    mocks.get.mockResolvedValue({ kind: 'ok', body: { total: 3 } });
    await show(ALL);
    expect(mocks.get).toHaveBeenCalledWith(expect.stringContaining('limit=1'));
    expect(screen.getByText('Issuer requests (3)')).toBeTruthy();
  });

  it('shows the plain label when nothing is open', async () => {
    mocks.get.mockResolvedValue({ kind: 'ok', body: { total: 0 } });
    await show(ALL);
    expect(screen.getByText('Issuer requests')).toBeTruthy();
  });

  it('shows the plain label when the read fails', async () => {
    mocks.get.mockResolvedValue({ kind: 'unavailable' });
    await show(ALL);
    expect(screen.getByText('Issuer requests')).toBeTruthy();
  });

  it('uses a given count without reading', async () => {
    await show(ALL, 5);
    expect(mocks.get).not.toHaveBeenCalled();
    expect(screen.getByText('Issuer requests (5)')).toBeTruthy();
  });

  it('does not read without the issuer view permission', async () => {
    await show(['certification.seller-certificate.view', 'certification.type.view']);
    expect(mocks.get).not.toHaveBeenCalled();
    expect(screen.queryByText(/Issuer requests/)).toBeNull();
  });
});
