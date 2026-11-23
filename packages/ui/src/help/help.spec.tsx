// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { HelpButton } from './help-button.tsx';
import { HelpProvider, useHelp } from './help-context.tsx';
import { Tabs } from '../shell/tabs.tsx';
import { HelpPanel, type HelpContent } from './help-panel.tsx';
import { PageHeader } from './page-header.tsx';
import { AccountMenu } from '../shell/account-menu.tsx';
import { AppShell } from '../shell/app-shell.tsx';

/** Stubs the viewport: `wide` is true from 1280 px. */
function setViewport(wide: boolean) {
  vi.stubGlobal('matchMedia', (query: string) => ({
    matches: query.includes('1280') ? wide : false,
    media: query,
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
  }));
}

beforeEach(() => setViewport(true));
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

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

  it('closes on Escape pressed anywhere on the page and returns focus', async () => {
    const user = userEvent.setup();
    render(<Harness />);
    const button = screen.getByRole('button', { name: 'Help' });
    await user.click(button);
    await user.click(screen.getByLabelText('Search box'));
    await user.keyboard('{Escape}');
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(document.activeElement).toBe(button);
  });

  it('leaves Escape inside a modal dialog and an open account menu to them', async () => {
    const user = userEvent.setup();
    render(
      <>
        <Harness />
        <dialog open>
          <button>Inside dialog</button>
        </dialog>
      </>,
    );
    await user.click(screen.getByRole('button', { name: 'Help' }));
    await user.click(screen.getByText('Inside dialog'));
    await user.keyboard('{Escape}');
    expect(screen.getByRole('dialog', { name: 'About Refunds' })).toBeTruthy();
  });

  it('does not use the ? key, which opens the shortcuts list', () => {
    render(<Harness />);
    fireEvent.keyDown(document.body, { key: '?' });
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('shows no button on a page without help text', () => {
    render(
      <HelpProvider hasContent={false}>
        <HelpButton label="Help" />
      </HelpProvider>,
    );
    expect(screen.queryByRole('button', { name: 'Help' })).toBeNull();
  });

  it('shows the open tab with its own points', async () => {
    const user = userEvent.setup();
    render(
      <Harness
        page={{
          ...content,
          tab: { name: 'Types', text: 'Kinds.', points: ['Needs a second admin.'] },
        }}
      />,
    );
    await user.click(screen.getByRole('button', { name: 'Help' }));
    expect(screen.getByText('Needs a second admin.')).toBeTruthy();
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

describe('Help panel below and above 1280 px', () => {
  it('has no modal semantics and the close button is its first focusable element', async () => {
    const user = userEvent.setup();
    render(<Harness />);
    await user.click(screen.getByRole('button', { name: 'Help' }));
    const dialog = screen.getByRole('dialog');
    expect(dialog.getAttribute('aria-modal')).toBe('false');
    expect(dialog.querySelector('button, a[href]')).toBe(
      screen.getByRole('button', { name: 'Close' }),
    );
    expect(screen.getByRole('button', { name: 'Close' }).className).toContain('size-11');
    expect(dialog.querySelector('div')?.className).toContain('items-center');
  });

  it('closes on a press outside the panel below 1280 px, without taking focus', async () => {
    setViewport(false);
    const user = userEvent.setup();
    render(<Harness />);
    await user.click(screen.getByRole('button', { name: 'Help' }));
    await user.click(screen.getByLabelText('Search box'));
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(document.activeElement).toBe(screen.getByLabelText('Search box'));
  });

  it('stays open on a press inside the panel and on the Help button itself below 1280 px', async () => {
    setViewport(false);
    const user = userEvent.setup();
    render(<Harness />);
    const button = screen.getByRole('button', { name: 'Help' });
    await user.click(button);
    await user.click(screen.getByText('Refunds returns money to buyers.'));
    expect(screen.getByRole('dialog')).toBeTruthy();
    await user.click(button);
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('stays open on a press outside the panel from 1280 px', async () => {
    setViewport(true);
    const user = userEvent.setup();
    render(<Harness />);
    await user.click(screen.getByRole('button', { name: 'Help' }));
    await user.click(screen.getByLabelText('Search box'));
    expect(screen.getByRole('dialog')).toBeTruthy();
  });

  it('reserves the panel column on the shell while it is open', async () => {
    const user = userEvent.setup();
    render(
      <HelpProvider>
        <AppShell
          labels={{
            menu: 'Menu',
            close: 'Close menu',
            more: 'More',
            main: 'Main',
            collapse: 'Collapse',
            expand: 'Expand',
            toasts: { region: 'Notifications', close: 'Dismiss' },
          }}
          sidebar={<nav>Side</nav>}
          topbar={<HelpButton label="Help" />}
        >
          <p>Page</p>
          <HelpPanel content={content} labels={labels} />
        </AppShell>
      </HelpProvider>,
    );
    const main = screen.getByRole('main');
    expect(main.className).not.toContain('xl:pe-96');
    await user.click(screen.getAllByRole('button', { name: 'Help' })[0] as HTMLElement);
    expect(main.className).toContain('xl:pe-96');
    expect(main.getAttribute('data-help-open')).toBe('true');
  });

  it('gives the Help button a 44 px hit area on phones and the search button border from tablets', () => {
    render(<Harness />);
    const className = screen.getByRole('button', { name: 'Help' }).className;
    expect(className).toContain('min-h-11');
    expect(className).toContain('min-w-11');
    expect(className).toContain('md:border');
    expect(className).toContain('border-line-control');
    expect(className).toContain('md:bg-subtle');
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

describe('Tabs that name their Help part', () => {
  it('tells the panel which tab is open', () => {
    function Page({ active }: { readonly active: string }) {
      const { tab } = useHelp();
      return (
        <>
          <Tabs
            label="Sections"
            activeId={active}
            items={[
              { id: 'a', label: 'Brands (12)', help: 'Brands' },
              { id: 'b', label: 'Duplicates (3)', help: 'Duplicates' },
            ]}
          />
          <p data-testid="open">{tab ?? 'none'}</p>
        </>
      );
    }
    const view = render(
      <HelpProvider>
        <Page active="b" />
      </HelpProvider>,
    );
    expect(screen.getByTestId('open').textContent).toBe('Duplicates');
    view.rerender(
      <HelpProvider>
        <Page active="a" />
      </HelpProvider>,
    );
    expect(screen.getByTestId('open').textContent).toBe('Brands');
  });
});
