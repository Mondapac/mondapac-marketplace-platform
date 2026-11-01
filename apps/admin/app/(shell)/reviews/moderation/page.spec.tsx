// @vitest-environment jsdom
import { cleanup, render, screen } from '@testing-library/react';
import { createTranslator } from 'next-intl';
import type { ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import messages from '../../../../messages/en.json';
import type { AdminSession } from '../../../../src/server/session.ts';
import ReviewModerationRoute from './page.tsx';

// The permission gate of the buyer-review queue: nothing is read without reviews.moderation.queue,
// and the page passes on only the actions the admin may take.

const mocks = vi.hoisted(() => ({ session: vi.fn() }));

vi.mock('next-intl/server', () => ({
  getTranslations: () => Promise.resolve(createTranslator({ locale: 'en-AU', messages })),
}));
vi.mock('../../../../src/server/session.ts', () => ({ requireSession: mocks.session }));
vi.mock('../../../../src/reviews/moderation-queue.tsx', () => ({
  ModerationQueue: (props: { canModerate: boolean; canRemove: boolean }) => (
    <p data-moderate={String(props.canModerate)} data-remove={String(props.canRemove)}>
      the queue
    </p>
  ),
}));
vi.mock('../../../../src/server/admin-shell.tsx', () => ({
  AdminShell: ({ children }: { readonly children: ReactNode }) => <main>{children}</main>,
}));

const session = (permissionKeys: string[]): AdminSession => ({
  accountId: 'a',
  roleId: 'r',
  permissionKeys,
  secondFactorActive: true,
  lastSignInAt: null,
  timezone: null,
  locale: null,
  email: 'ada@example.test',
  displayName: 'Ada',
  csrfToken: 'c',
});

beforeEach(() => mocks.session.mockReset());
afterEach(cleanup);

describe('buyer review queue page', () => {
  it('shows the queue to someone with the view permission, with the actions they hold', async () => {
    mocks.session.mockResolvedValue({
      kind: 'ok',
      session: session(['reviews.moderation.queue', 'reviews.moderation.moderate']),
    });
    render(await ReviewModerationRoute());
    const queue = screen.getByText('the queue');
    expect(queue.getAttribute('data-moderate')).toBe('true');
    expect(queue.getAttribute('data-remove')).toBe('false');
  });

  it('shows no queue without the view permission', async () => {
    mocks.session.mockResolvedValue({ kind: 'ok', session: session([]) });
    render(await ReviewModerationRoute());
    expect(screen.queryByText('the queue')).toBeNull();
    expect(screen.getByText('You do not have access to the buyer review queue.')).toBeTruthy();
    expect(screen.getByRole('heading', { name: 'Buyer reviews' })).toBeTruthy();
  });

  it('keeps its heading when there is no session', async () => {
    mocks.session.mockResolvedValue({ kind: 'unavailable' });
    render(await ReviewModerationRoute());
    expect(screen.getByRole('heading', { name: 'Buyer reviews' })).toBeTruthy();
  });
});
