// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, describe, expect, it } from 'vitest';
import { HelpButton } from './help-button.tsx';
import { HelpProvider } from './help-context.tsx';
import { HelpPanel, type HelpContent } from './help-panel.tsx';
import { PageHeader } from './page-header.tsx';
import { AccountMenu } from '../shell/account-menu.tsx';

afterEach(cleanup);

const labels = {
  about: 'About',
  thisTab: 'This tab',
  goodToKnow: 'Good to know',
  related: 'Related',
  learnMore: 'Learn more',
  close: 'Close',
};

const content: HelpContent = {
  page: 'Refunds',
  about: 'Refunds returns money to buyers.',
  goodToKnow: ['Amounts are in the order currency.'],
  related: [{ label: 'Orders', href: '/orders' }],
};

function Harness({ page = content }: { readonly page?: HelpContent }) {
  return (
    <HelpProvider>
      <input aria-label="Search box" />
      <HelpButton label="Help" />
      <HelpPanel content={page} labels={labels} />
    </HelpProvider>
  );
}

describe('PageHeader', () => {
  it('renders one h1, an optional status pill and the actions, and no line under the title', () => {
    const html = renderToStaticMarkup(
      <PageHeader
        title="Review queue"
        status="Live · every 30 s"
        actions={<button>Bulk</button>}
      />,
    );
    expect(html.match(/<h1/g)).toHaveLength(1);
    expect(html).toContain('Live · every 30 s');
    expect(html).toContain('<button>Bulk</button>');
    expect(html).not.toContain('<p');
  });

  it('leaves out the pill and the actions when not given', () => {
    const html = renderToStaticMarkup(<PageHeader title="Brands" />);
    expect(html).not.toContain('<span');
  });
});

describe('Help button and panel', () => {
  it('starts closed with an accessible name and aria-expanded=false', () => {
    render(<Harness />);
    const button = screen.getByRole('button', { name: 'Help' });
    expect(button.getAttribute('aria-expanded')).toBe('false');
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('opens a non-modal dialog named "About <page>" and wires aria-controls', async () => {
    const user = userEvent.setup();
    render(<Harness />);
    const button = screen.getByRole('button', { name: 'Help' });
    await user.click(button);
    const dialog = screen.getByRole('dialog', { name: 'About Refunds' });
    expect(dialog.getAttribute('aria-modal')).toBe('false');
    expect(button.getAttribute('aria-expanded')).toBe('true');
    expect(button.getAttribute('aria-controls')).toBe(dialog.id);
    expect(screen.getByText('Refunds returns money to buyers.')).toBeTruthy();
    expect(screen.getByRole('link', { name: 'Orders' }).getAttribute('href')).toBe('/orders');
  });

  it('hides empty sections, including Learn more until there are articles', async () => {
    const user = userEvent.setup();
    render(<Harness page={{ page: 'Brands', about: 'Brands group products.' }} />);
    await user.click(screen.getByRole('button', { name: 'Help' }));
    expect(screen.queryByText('Good to know')).toBeNull();
    expect(screen.queryByText('Related')).toBeNull();
    expect(screen.queryByText('Learn more')).toBeNull();
  });

  it('closes on Escape and returns focus to the Help button', async () => {
    const user = userEvent.setup();
    render(<Harness />);
    const button = screen.getByRole('button', { name: 'Help' });
    await user.click(button);
    await user.keyboard('{Escape}');
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(document.activeElement).toBe(button);
  });

  it('closes with the close button and returns focus', async () => {
    const user = userEvent.setup();
    render(<Harness />);
    const button = screen.getByRole('button', { name: 'Help' });
    await user.click(button);
    await user.click(screen.getByRole('button', { name: 'Close' }));
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(document.activeElement).toBe(button);
  });

  it('stays open when the content changes (tab switch) and swaps only the tab text', async () => {
    const user = userEvent.setup();
    const first: HelpContent = { ...content, tab: { name: 'Issuers', text: 'Issuers text.' } };
    const second: HelpContent = { ...content, tab: { name: 'Types', text: 'Types text.' } };
    const view = render(<Harness page={first} />);
    await user.click(screen.getByRole('button', { name: 'Help' }));
    expect(screen.getByText('Issuers text.')).toBeTruthy();
    view.rerender(<Harness page={second} />);
    expect(screen.getByRole('dialog')).toBeTruthy();
    expect(screen.getByText('Types text.')).toBeTruthy();
    expect(screen.queryByText('Issuers text.')).toBeNull();
    expect(screen.getByText('Refunds returns money to buyers.')).toBeTruthy();
  });

  it('toggles with ? but not while typing or with a modifier', async () => {
    const user = userEvent.setup();
    render(<Harness />);
    await user.click(screen.getByLabelText('Search box'));
    await user.keyboard('?');
    expect(screen.queryByRole('dialog')).toBeNull();
    (document.activeElement as HTMLElement).blur();
    fireEvent.keyDown(document.body, { key: '?', ctrlKey: true });
    expect(screen.queryByRole('dialog')).toBeNull();
    fireEvent.keyDown(document.body, { key: '?' });
    expect(screen.getByRole('dialog')).toBeTruthy();
    fireEvent.keyDown(document.body, { key: '?' });
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('shows nothing when the page has no content', async () => {
    const user = userEvent.setup();
    render(
      <HelpProvider>
        <HelpButton label="Help" />
        <HelpPanel content={null} labels={labels} />
      </HelpProvider>,
    );
    await user.click(screen.getByRole('button', { name: 'Help' }));
    expect(screen.queryByRole('dialog')).toBeNull();
  });
});

describe('Account menu zone line', () => {
  const props = {
    name: 'Ada Lovelace',
    email: 'ada@example.com',
    links: [],
    theme: 'system' as const,
    labels: {
      trigger: 'Account menu',
      pages: 'Your account',
      theme: 'Theme',
      signOut: 'Sign out',
      signingOut: 'Signing out',
      system: 'System',
      light: 'Light',
      dark: 'Dark',
    },
    onSignOut: () => Promise.resolve(false),
  };

  it('shows the zone line in the open menu only when given', async () => {
    const user = userEvent.setup();
    render(<AccountMenu {...props} zone="Times are in Australia/Brisbane." />);
    await user.click(screen.getByRole('button', { name: 'Account menu' }));
    expect(screen.getByText('Times are in Australia/Brisbane.')).toBeTruthy();
    cleanup();
    render(<AccountMenu {...props} />);
    await user.click(screen.getByRole('button', { name: 'Account menu' }));
    expect(screen.queryByText(/Times are in/u)).toBeNull();
  });
});
