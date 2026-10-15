import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('server-only', () => ({}));
const serverGet = vi.fn<(path: string, options?: unknown) => Promise<unknown>>();
vi.mock('./server-fetch.ts', () => ({
  serverGet: (path: string, options?: unknown) => serverGet(path, options),
}));
vi.mock('./config.ts', () => ({ panelConfig: () => ({ supportEmail: 'env@example.com' }) }));

const { supportEmail } = await import('./support-email.ts');

describe('supportEmail', () => {
  beforeEach(() => serverGet.mockReset());

  it('shows the address an admin set, read from the public route', async () => {
    serverGet.mockResolvedValue({ kind: 'ok', body: { email: 'help@example.com' } });
    await expect(supportEmail()).resolves.toBe('help@example.com');
    expect(serverGet).toHaveBeenCalledWith('notifications/support-contact', { anonymous: true });
  });

  it.each([
    [{ kind: 'unavailable' }],
    [{ kind: 'ok', body: { email: null } }],
    [{ kind: 'ok', body: { email: '' } }],
  ])('falls back to the environment value for %j', async (answer) => {
    serverGet.mockResolvedValue(answer);
    await expect(supportEmail()).resolves.toBe('env@example.com');
  });
});
