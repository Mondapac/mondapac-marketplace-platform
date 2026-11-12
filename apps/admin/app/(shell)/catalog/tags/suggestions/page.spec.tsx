// @vitest-environment jsdom
import { cleanup, render, screen } from '@testing-library/react';
import { createTranslator } from 'next-intl';
import type { ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import messages from '../../../../../messages/en.json';
import type { AdminSession } from '../../../../../src/server/session.ts';
import TagSuggestionsPage from './page.tsx';

const mocks = vi.hoisted(() => ({ session: vi.fn() }));

vi.mock('next-intl/server', () => ({
  getTranslations: (namespace?: string) =>
    Promise.resolve(
      createTranslator({
        locale: 'en-AU',
        messages,
        ...(namespace === undefined ? {} : { namespace }),
      } as never),
    ),
}));
vi.mock('../../../../../src/server/session.ts', () => ({ requireSession: mocks.session }));
vi.mock('../../../../../src/server/admin-shell.tsx', () => ({
  AdminShell: ({
    children,
    activeId,
  }: {
    readonly children: ReactNode;
    readonly activeId: string;
  }) => <div data-active={activeId}>{children}</div>,
}));
vi.mock('../../../../../src/tags/suggestions-view.tsx', () => ({
  SuggestionsView: (props: { readonly canApprove: boolean; readonly csrfToken: string }) => (
    <p data-testid="view" data-can-approve={String(props.canApprove)} data-csrf={props.csrfToken}>
      view
    </p>
  ),
}));

const session = (permissionKeys: string[]): AdminSession =>
  ({ permissionKeys, csrfToken: 'csrf-9' }) as unknown as AdminSession;
const open = async () => render(await TagSuggestionsPage());

describe('admin tag suggestions page', () => {
  beforeEach(() => vi.clearAllMocks());
  afterEach(cleanup);

  it('shows the queue to a reviewer who cannot manage tags, with Approve off', async () => {
    mocks.session.mockResolvedValue({
      kind: 'ok',
      session: session(['catalog.topic-suggestion.review']),
    });
    const { container } = await open();
    expect(screen.getByTestId('view').getAttribute('data-can-approve')).toBe('false');
    expect(screen.getByTestId('view').getAttribute('data-csrf')).toBe('csrf-9');
    expect(container.querySelector('[data-active="tags"]')).not.toBeNull();
  });

  it('lets a reviewer who can manage tags approve', async () => {
    mocks.session.mockResolvedValue({
      kind: 'ok',
      session: session(['catalog.topic-suggestion.review', 'catalog.topic.manage']),
    });
    await open();
    expect(screen.getByTestId('view').getAttribute('data-can-approve')).toBe('true');
  });

  it('renders NoAccess, and no queue, without the review key', async () => {
    mocks.session.mockResolvedValue({ kind: 'ok', session: session(['catalog.topic.manage']) });
    await open();
    expect(screen.queryByTestId('view')).toBeNull();
    expect(screen.getByText('You do not have access to tag suggestions')).toBeTruthy();
  });

  it('shows the load error when the session cannot be read', async () => {
    mocks.session.mockResolvedValue({ kind: 'unavailable' });
    await open();
    expect(screen.queryByTestId('view')).toBeNull();
  });
});
