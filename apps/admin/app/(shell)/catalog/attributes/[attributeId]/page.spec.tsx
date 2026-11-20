// @vitest-environment jsdom
import { cleanup, render, screen } from '@testing-library/react';
import { createTranslator } from 'next-intl';
import type { ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import messages from '../../../../../messages/en.json';
import type { AdminSession } from '../../../../../src/server/session.ts';
import AttributePage from './page.tsx';

const mocks = vi.hoisted(() => ({
  session: vi.fn(),
  notFound: vi.fn(() => {
    throw new Error('not-found');
  }),
}));

vi.mock('next-intl/server', () => ({
  getTranslations: () => Promise.resolve(createTranslator({ locale: 'en-AU', messages })),
}));
vi.mock('next/navigation', () => ({ notFound: mocks.notFound }));
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
vi.mock('../../../../../src/attributes/attribute-detail-page.tsx', () => ({
  AttributeDetailPage: (props: Readonly<Record<string, string | boolean>>) => (
    <p
      data-testid="detail"
      {...Object.fromEntries(
        Object.entries(props).map(([k, v]) => [`data-${k.toLowerCase()}`, String(v)]),
      )}
    >
      detail
    </p>
  ),
}));

const ID = '0190a000-0000-7000-8000-000000000001';
const session = (permissionKeys: string[]): AdminSession =>
  ({ permissionKeys, csrfToken: 'csrf-9' }) as unknown as AdminSession;
const open = async (attributeId = ID) =>
  render(await AttributePage({ params: Promise.resolve({ attributeId }) }));

describe('admin attribute page', () => {
  beforeEach(() => vi.clearAllMocks());
  afterEach(cleanup);

  it('opens the attribute with what the role may do', async () => {
    mocks.session.mockResolvedValue({
      kind: 'ok',
      session: session(['catalog.attribute.view', 'catalog.attribute.edit']),
    });
    const { container } = await open();
    const detail = screen.getByTestId('detail');
    expect(detail.getAttribute('data-attributeid')).toBe(ID);
    expect(detail.getAttribute('data-canedit')).toBe('true');
    expect(detail.getAttribute('data-canrestructure')).toBe('false');
    expect(detail.getAttribute('data-csrftoken')).toBe('csrf-9');
    expect(container.querySelector('[data-active="attributes"]')).not.toBeNull();
  });

  it('answers not found for an address that is not an attribute id', async () => {
    mocks.session.mockResolvedValue({ kind: 'ok', session: session(['catalog.attribute.view']) });
    await expect(open('nope')).rejects.toThrow('not-found');
  });

  it('shows a no-access message without the view key, and an error when the session cannot be read', async () => {
    mocks.session.mockResolvedValue({ kind: 'ok', session: session([]) });
    await open();
    expect(screen.queryByTestId('detail')).toBeNull();
    expect(screen.getByText(/You do not have access to attributes/)).toBeTruthy();
    cleanup();
    mocks.session.mockResolvedValue({ kind: 'unavailable' });
    await open();
    expect(screen.queryByTestId('detail')).toBeNull();
  });
});
