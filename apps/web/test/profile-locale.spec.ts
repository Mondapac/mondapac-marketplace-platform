import { beforeEach, describe, expect, it, vi } from 'vitest';

const read = vi.hoisted(() => vi.fn());
vi.mock('server-only', () => ({}));
vi.mock('../src/storefront/session.ts', () => ({ sessionGet: read }));

import { readProfileLocale } from '../src/i18n/profile-locale.ts';

beforeEach(() => read.mockReset());

describe('readProfileLocale', () => {
  it('asks nothing while only English is published', async () => {
    await expect(readProfileLocale(['en'])).resolves.toBeNull();
    expect(read).not.toHaveBeenCalled();
  });

  it('returns the language kept on the account', async () => {
    read.mockResolvedValue({ kind: 'ok', body: { locale: 'fa' } });
    await expect(readProfileLocale(['en', 'fa'])).resolves.toBe('fa');
    expect(read).toHaveBeenCalledWith('identity/customer/session');
  });

  it.each([
    [{ kind: 'ok', body: { locale: null } }],
    [{ kind: 'ok', body: {} }],
    [{ kind: 'ok', body: { locale: 7 } }],
    [{ kind: 'failed', status: 401 }],
    [{ kind: 'off' }],
  ])('reads %j as no choice (a guest, an ended session or the API off)', async (answer) => {
    read.mockResolvedValue(answer);
    await expect(readProfileLocale(['en', 'fa'])).resolves.toBeNull();
  });
});
