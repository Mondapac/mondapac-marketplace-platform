import { beforeEach, describe, expect, it, vi } from 'vitest';

// The (shell) layout sends a signed-out visitor to sign-in before any of the panel renders, so the
// shell frame and the skeleton of loading.tsx never show before the sign-in page. The API read is
// a double; redirect throws as Next's does.

const mocks = vi.hoisted(() => ({
  serverGet: vi.fn(),
  cookies: vi.fn(),
  headers: vi.fn(),
  redirect: vi.fn((path: string) => {
    throw new Error(`REDIRECT:${path}`);
  }),
}));

vi.mock('server-only', () => ({}));
vi.mock('./server-fetch.ts', () => ({ serverGet: mocks.serverGet }));
vi.mock('next/headers', () => ({ cookies: mocks.cookies, headers: mocks.headers }));
vi.mock('next/navigation', () => ({ redirect: mocks.redirect }));

import ShellLayout from '../../app/(shell)/layout.tsx';

const jar = (names: string[]) => ({ getAll: () => names.map((name) => ({ name, value: 'x' })) });

beforeEach(() => {
  vi.clearAllMocks();
  mocks.cookies.mockResolvedValue(jar([]));
  mocks.headers.mockResolvedValue(new Headers());
});

describe('(shell) layout', () => {
  it('redirects a visitor with no session to sign-in before rendering the panel', async () => {
    mocks.serverGet.mockResolvedValue({ kind: 'signed-out' });
    await expect(ShellLayout({ children: 'panel' })).rejects.toThrow('REDIRECT:/sign-in');
  });

  it('keeps the page asked for, so sign-in can return to it', async () => {
    mocks.serverGet.mockResolvedValue({ kind: 'signed-out' });
    mocks.headers.mockResolvedValue(new Headers({ 'x-mp-requested-path': '/orders?view=late' }));
    await expect(ShellLayout({ children: 'panel' })).rejects.toThrow(
      'REDIRECT:/sign-in?next=%2Forders%3Fview%3Dlate',
    );
  });

  it('carries the page asked for through session-ended', async () => {
    mocks.serverGet.mockResolvedValue({ kind: 'signed-out' });
    mocks.cookies.mockResolvedValue(jar(['__Host-session-admin-abc']));
    mocks.headers.mockResolvedValue(new Headers({ 'x-mp-requested-path': '/orders' }));
    await expect(ShellLayout({ children: 'panel' })).rejects.toThrow(
      'REDIRECT:/session-ended?next=%2Forders',
    );
  });

  it('drops a requested path that could leave the panel', async () => {
    mocks.serverGet.mockResolvedValue({ kind: 'signed-out' });
    mocks.headers.mockResolvedValue(new Headers({ 'x-mp-requested-path': '//evil.example' }));
    await expect(ShellLayout({ children: 'panel' })).rejects.toThrow(/^REDIRECT:\/sign-in$/);
  });

  it('sends a visitor whose session cookie was rejected to session-ended', async () => {
    mocks.serverGet.mockResolvedValue({ kind: 'signed-out' });
    mocks.cookies.mockResolvedValue(jar(['__Host-session-admin-abc']));
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
