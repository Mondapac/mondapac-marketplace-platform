import { beforeEach, describe, expect, it, vi } from 'vitest';

// The (shell) layout sends a signed-out visitor to sign-in before any of the panel renders, so the
// shell frame and the skeleton of loading.tsx never show before the sign-in page. The API read is
// a double; redirect throws as Next's does.

const mocks = vi.hoisted(() => ({
  serverGet: vi.fn(),
  cookies: vi.fn(),
  redirect: vi.fn((path: string) => {
    throw new Error(`REDIRECT:${path}`);
  }),
}));

vi.mock('server-only', () => ({}));
vi.mock('./server-fetch.ts', () => ({ serverGet: mocks.serverGet }));
vi.mock('next/headers', () => ({ cookies: mocks.cookies }));
vi.mock('next/navigation', () => ({ redirect: mocks.redirect }));

import ShellLayout from '../../app/(shell)/layout.tsx';

const jar = (names: string[]) => ({ getAll: () => names.map((name) => ({ name, value: 'x' })) });

beforeEach(() => {
  vi.clearAllMocks();
  mocks.cookies.mockResolvedValue(jar([]));
});

describe('(shell) layout', () => {
  it('redirects a visitor with no session to sign-in before rendering the panel', async () => {
    mocks.serverGet.mockResolvedValue({ kind: 'signed-out' });
    await expect(ShellLayout({ children: 'panel' })).rejects.toThrow('REDIRECT:/sign-in');
  });

  it('sends a visitor whose session cookie was rejected to session-ended', async () => {
    mocks.serverGet.mockResolvedValue({ kind: 'signed-out' });
    mocks.cookies.mockResolvedValue(jar(['__Host-session-seller-abc']));
    await expect(ShellLayout({ children: 'panel' })).rejects.toThrow('REDIRECT:/session-ended');
  });

  it('renders the panel for a signed-in visitor', async () => {
    mocks.serverGet.mockResolvedValue({ kind: 'ok', body: { accountId: 'a' } });
    await expect(ShellLayout({ children: 'panel' })).resolves.toBe('panel');
    expect(mocks.redirect).not.toHaveBeenCalled();
  });

  it('lets the page show its own error when the session cannot be read', async () => {
    mocks.serverGet.mockResolvedValue({ kind: 'unavailable' });
    await expect(ShellLayout({ children: 'panel' })).resolves.toBe('panel');
    expect(mocks.redirect).not.toHaveBeenCalled();
  });
});
