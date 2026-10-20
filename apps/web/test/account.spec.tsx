// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { NextIntlClientProvider } from 'next-intl';
import type { ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import messages from '../messages/en.json';
import { AccountDrawer } from '../src/account/account-drawer.tsx';
import { AccountArea } from '../src/account/account-area.tsx';
import { AuthForms } from '../src/account/auth-forms.tsx';
import { AccountAddresses } from '../src/account/addresses.tsx';
import { AccountLists } from '../src/account/lists.tsx';
import { LoginModal } from '../src/account/login-modal.tsx';
import { OrderDetails } from '../src/account/order-details.tsx';
import { AccountOrders } from '../src/account/orders.tsx';
import { AccountOverview } from '../src/account/overview.tsx';
import { AccountSettings } from '../src/account/settings.tsx';
import { summarise } from '../src/cart/cart.ts';
import { Header } from '../src/shell/header.tsx';
import { Rail } from '../src/shell/rail.tsx';
import { StoreProvider, useStore } from '../src/shell/store-context.tsx';
import { TabBar } from '../src/shell/tab-bar.tsx';
import { SAMPLE_CART_SOURCE } from '../src/storefront/sample-cart.ts';
import { SOCIAL_SIGN_IN_SHOWN, TAX_INVOICE_SHOWN } from '../src/storefront/features.ts';
import { loadAccount } from '../src/storefront/source.ts';

const nav = vi.hoisted(() => ({ path: '/', push: vi.fn() }));
vi.mock('next/navigation', () => ({
  usePathname: () => nav.path,
  useSearchParams: () => new URLSearchParams(),
  useRouter: () => ({ push: nav.push, replace: () => undefined }),
}));

beforeEach(() => {
  nav.path = '/';
  nav.push.mockReset();
  window.matchMedia = (() => ({
    matches: false,
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
  })) as unknown as typeof window.matchMedia;
});
afterEach(cleanup);

const account = await loadAccount();

/** Shows the cart's item count, to check what Buy again and Add to cart put in it. */
function CartCount() {
  const { cart } = useStore();
  return <output data-testid="cart">{summarise(cart).count}</output>;
}

function renderStore(children: ReactNode, signedIn = true) {
  return render(
    <NextIntlClientProvider locale="en" messages={messages} timeZone="UTC">
      <StoreProvider
        cartSource={SAMPLE_CART_SOURCE}
        initialCustomer={signedIn ? account.customer : null}
      >
        <Header delivery={{ label: 'Kedron 4031' }} />
        <Rail />
        <TabBar />
        <LoginModal customer={account.customer} />
        <AccountDrawer />
        <main>
          <AccountArea source={account}>{children}</AccountArea>
        </main>
        <CartCount />
      </StoreProvider>
    </NextIntlClientProvider>,
  );
}

const rail = () => screen.getByRole('navigation', { name: 'Main menu' });
const main = () => screen.getByRole('main');
const cartCount = () => Number(screen.getByTestId('cart').textContent);

describe('global account menu', () => {
  it('signed out: one My Account row and a Log in button that open the log-in dialog', () => {
    renderStore(<AccountOverview />, false);
    expect(within(rail()).queryByRole('link', { name: 'Orders' })).toBeNull();
    expect(within(rail()).queryByText('You')).toBeNull();
    fireEvent.click(within(rail()).getByRole('button', { name: 'My Account' }));
    expect(screen.getByRole('dialog', { name: 'Log in' })).toBeTruthy();
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(screen.queryByRole('dialog', { name: 'Log in' })).toBeNull();
    fireEvent.click(within(screen.getByRole('banner')).getByRole('button', { name: 'Log in' }));
    expect(screen.getByRole('dialog', { name: 'Log in' })).toBeTruthy();
  });

  it('signed in: the ringed heading, the five account pages and Log out', () => {
    nav.path = '/account/orders/MP-20481';
    renderStore(<AccountOverview />);
    const r = rail();
    expect(within(r).getByRole('heading', { name: /My Account/ }).textContent).toContain(
      'Signed in as Alex Nguyen',
    );
    const links = within(r)
      .getAllByRole('link')
      .filter((a) => a.getAttribute('href')?.startsWith('/account'))
      .map((a) => [a.textContent, a.getAttribute('href')]);
    expect(links).toEqual([
      ['Overview', '/account'],
      ['Orders', '/account/orders'],
      ['Addresses', '/account/addresses'],
      ['Saved lists', '/account/lists'],
      ['Settings', '/account/settings'],
    ]);
    expect(within(r).getByRole('link', { name: 'Orders' }).getAttribute('aria-current')).toBe(
      'page',
    );
    expect(within(r).getByRole('button', { name: 'Log out' })).toBeTruthy();
  });

  it('header says Log out (never the name) when signed in and logs out on click', () => {
    renderStore(<AccountOverview />);
    const header = screen.getByRole('banner');
    expect(header.textContent).not.toContain('Alex');
    fireEvent.click(within(header).getByRole('button', { name: 'Log out' }));
    expect(nav.push).toHaveBeenCalledWith('/account');
    expect(within(header).getByRole('button', { name: 'Log in' })).toBeTruthy();
    expect(screen.getByRole('heading', { level: 1, name: 'Log in' })).toBeTruthy();
  });

  it('Account tab: log-in dialog signed out; signed in, the account panel with a dot', () => {
    renderStore(<AccountOverview />);
    const tabs = screen.getByRole('navigation', { name: 'App navigation' });
    const tab = within(tabs).getByRole('button', { name: /Account/ });
    expect(tab.textContent).toContain('signed in');
    expect(tab.querySelector('.tdot')).not.toBeNull();
    tab.focus();
    fireEvent.click(tab);
    const panel = screen.getByRole('dialog', { name: 'My Account' });
    expect(within(panel).getByText('Signed in as Alex Nguyen')).toBeTruthy();
    expect(
      within(panel)
        .getAllByRole('link')
        .map((a) => a.textContent),
    ).toEqual(['Overview', 'Orders', 'Addresses', 'Saved lists', 'Settings']);
    expect(within(panel).getByRole('link', { name: 'Overview' })).toBe(document.activeElement);
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(document.querySelector('.adw.open')).toBeNull();
    expect(document.activeElement).toBe(tab);
  });
});

describe('log in', () => {
  it('signs in from the dialog and opens the overview', () => {
    renderStore(<AccountOverview />, false);
    fireEvent.click(within(screen.getByRole('banner')).getByRole('button', { name: 'Log in' }));
    const dialog = screen.getByRole('dialog', { name: 'Log in' });
    fireEvent.submit(within(dialog).getByLabelText('Email').closest('form')!);
    expect(nav.push).toHaveBeenCalledWith('/account');
    expect(screen.queryByRole('dialog', { name: 'Log in' })).toBeNull();
    expect(screen.getByRole('heading', { level: 1, name: 'My account' })).toBeTruthy();
  });

  it('shows the password on request and resets without saying whether the email exists', () => {
    renderStore(<AccountOverview />, false);
    const page = main();
    const password = within(page).getByLabelText<HTMLInputElement>('Password');
    expect(password.type).toBe('password');
    const eye = within(page).getByRole('button', { name: 'Show password' });
    fireEvent.click(eye);
    expect(password.type).toBe('text');
    expect(eye.getAttribute('aria-pressed')).toBe('true');
    expect(eye.getAttribute('aria-label')).toBe('Hide password');
    fireEvent.click(within(page).getByRole('button', { name: 'Forgot password?' }));
    expect(within(page).getByRole('heading', { name: 'Reset your password' })).toBeTruthy();
    fireEvent.submit(within(page).getByLabelText('Email').closest('form')!);
    expect(within(page).getByRole('status').textContent).toContain(
      'If an account exists for that email',
    );
  });

  it('switches to Create account with the name field and the 10-character hint', () => {
    renderStore(<AccountOverview />, false);
    const page = main();
    fireEvent.click(within(page).getByRole('button', { name: 'Create account' }));
    expect(within(page).getByRole('heading', { name: 'Create your account' })).toBeTruthy();
    expect(within(page).getByLabelText('Full name')).toBeTruthy();
    expect(within(page).getByText('At least 10 characters.')).toBeTruthy();
  });
});

describe('social sign-in', () => {
  function renderForms(start: () => Promise<'signed-in' | 'failed' | 'cancelled'>) {
    const signedIn = vi.fn();
    render(
      <NextIntlClientProvider locale="en" messages={messages} timeZone="UTC">
        <AuthForms
          heading={(title) => <h1>{title}</h1>}
          onSignedIn={signedIn}
          social
          startSocial={start}
        />
      </NextIntlClientProvider>,
    );
    return signedIn;
  }

  it('stays hidden until the server side ships', () => {
    expect(SOCIAL_SIGN_IN_SHOWN).toBe(false);
    renderStore(<AccountOverview />, false);
    expect(screen.queryByRole('button', { name: /Continue with/ })).toBeNull();
  });

  it('waits on the pressed provider, then signs in', async () => {
    let finish: (result: 'signed-in') => void = () => undefined;
    const signedIn = renderForms(() => new Promise((resolve) => (finish = resolve)));
    fireEvent.click(screen.getByRole('button', { name: 'Continue with Google' }));
    const busy = screen.getByRole('button', { name: 'Connecting to Google…' });
    expect(busy.getAttribute('aria-busy')).toBe('true');
    expect(
      screen.getByRole('button', { name: 'Continue with Apple' }).getAttribute('aria-disabled'),
    ).toBe('true');
    await act(async () => {
      finish('signed-in');
      await Promise.resolve();
    });
    expect(signedIn).toHaveBeenCalledOnce();
  });

  it('says a failure and keeps the email form; a cancel says nothing', async () => {
    const signedIn = renderForms(() => Promise.resolve('failed'));
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Continue with Apple' }));
      await Promise.resolve();
    });
    expect(screen.getByRole('alert').textContent).toContain('could not log you in with Apple');
    expect(screen.getByLabelText('Email')).toBeTruthy();
    expect(signedIn).not.toHaveBeenCalled();
    cleanup();
    renderForms(() => Promise.resolve('cancelled'));
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Continue with Google' }));
      await Promise.resolve();
    });
    expect(screen.queryByRole('alert')).toBeNull();
    expect(screen.getByRole('button', { name: 'Continue with Google' })).toBeTruthy();
  });
});

describe('overview', () => {
  it('greets, shows the latest order and the quick tiles, without a Log out button', () => {
    renderStore(<AccountOverview />);
    const page = main();
    expect(within(page).getByText('Hello, Alex')).toBeTruthy();
    const latest = within(page).getByRole('region', { name: 'Latest order' });
    expect(within(latest).getByText('MP-20481')).toBeTruthy();
    expect(within(latest).getByText('A$93.10')).toBeTruthy();
    expect(within(page).getByRole('link', { name: /Addresses/ }).textContent).toContain('2 saved');
    expect(within(page).queryByRole('button', { name: 'Log out' })).toBeNull();
  });
});

describe('orders', () => {
  it('filters by state and empties a filter with a way back to all', () => {
    renderStore(<AccountOrders />);
    const page = main();
    expect(within(page).getAllByRole('article')).toHaveLength(4);
    fireEvent.click(within(page).getByRole('button', { name: 'Cancelled' }));
    const shown = within(page).getAllByRole('article');
    expect(shown.map((a) => a.getAttribute('aria-label'))).toEqual(['MP-20290']);
    expect(within(shown[0]!).queryByRole('button', { name: 'Buy again' })).toBeNull();
  });

  it('Buy again puts the order lines in the cart', () => {
    renderStore(<AccountOrders />);
    const first = within(main()).getAllByRole('article')[0]!;
    fireEvent.click(within(first).getByRole('button', { name: 'Buy again' }));
    expect(cartCount()).toBe(4);
    const done = within(first).getByRole('button', { name: 'Added to cart' });
    expect(done.getAttribute('aria-disabled')).toBe('true');
    fireEvent.click(done);
    expect(cartCount()).toBe(4);
  });
});

describe('order details', () => {
  it('shows each seller part, the GST line and no cancel once a seller confirmed', () => {
    renderStore(<OrderDetails reference="MP-20481" />);
    const page = main();
    expect(within(page).getByText(/This order has 2 parts/)).toBeTruthy();
    expect(within(page).getByText('Prices include GST. Includes A$8.46 GST.')).toBeTruthy();
    expect(within(page).getByText('Please ring the bell twice.')).toBeTruthy();
    expect(within(page).queryByRole('button', { name: 'Cancel order' })).toBeNull();
    expect(within(page).getByText(/can be cancelled only until a seller confirms/)).toBeTruthy();
    expect(within(page).queryByText('Tax invoice (PDF)')).toBeNull();
    expect(TAX_INVOICE_SHOWN).toBe(false);
  });

  it('cancels an order no seller has confirmed, after asking', () => {
    renderStore(<OrderDetails reference="MP-20412" />);
    const page = main();
    fireEvent.click(within(page).getByRole('button', { name: 'Cancel order' }));
    const ask = within(page).getByRole('alertdialog');
    fireEvent.click(within(ask).getByRole('button', { name: 'Keep order' }));
    expect(within(page).getByRole('button', { name: 'Cancel order' })).toBe(document.activeElement);
    fireEvent.click(within(page).getByRole('button', { name: 'Cancel order' }));
    fireEvent.click(within(page).getByRole('button', { name: 'Yes, cancel order' }));
    expect(within(page).getByText(/Your card was not charged/)).toBeTruthy();
    expect(within(page).queryByRole('button', { name: 'Buy again' })).toBeNull();
  });
});

describe('addresses', () => {
  it('saves an address outside the area with a notice, and refuses a bad postcode', () => {
    renderStore(<AccountAddresses />);
    const page = main();
    fireEvent.click(within(page).getByRole('button', { name: 'Add an address' }));
    const type = (label: string, text: string) =>
      fireEvent.change(within(page).getByLabelText(label), { target: { value: text } });
    type('Label', 'Gold Coast');
    type('Full name', 'Alex Nguyen');
    type('Street address and unit', '1 Beach Road');
    type('Suburb', 'Surfers Paradise');
    type('Postcode', '42');
    type('Mobile number', '0400 000 000');
    fireEvent.click(within(page).getByRole('button', { name: 'Save address' }));
    expect(within(page).getByText('Enter a 4-digit postcode.')).toBeTruthy();
    expect(document.activeElement).toBe(within(page).getByLabelText('Postcode'));
    type('Postcode', '4217');
    expect(within(page).getByRole('status').textContent).toContain('We do not deliver to 4217');
    fireEvent.click(within(page).getByRole('button', { name: 'Save address' }));
    const card = within(page).getByRole('article', { name: 'Gold Coast' });
    expect(card.textContent).toContain('1 Beach Road, Surfers Paradise QLD 4217');
    expect(within(card).getByText('Outside our delivery area')).toBeTruthy();
  });

  it('makes another address the default and deletes after asking', () => {
    renderStore(<AccountAddresses />);
    const page = main();
    fireEvent.click(within(page).getByRole('button', { name: 'Make Work the default' }));
    expect(within(page).getByRole('article', { name: 'Work' }).className).toContain('def');
    fireEvent.click(within(page).getByRole('button', { name: 'Delete Work' }));
    fireEvent.click(within(page).getByRole('button', { name: 'Keep' }));
    expect(document.activeElement).toBe(within(page).getByRole('button', { name: 'Delete Work' }));
    fireEvent.click(within(page).getByRole('button', { name: 'Delete Work' }));
    fireEvent.click(within(page).getByRole('button', { name: 'Delete' }));
    expect(within(page).queryByRole('article', { name: 'Work' })).toBeNull();
    expect(document.activeElement).toBe(within(page).getByRole('button', { name: 'Delete Home' }));
    expect(within(page).getByRole('article', { name: 'Home' }).className).toContain('def');
  });
});

describe('saved lists', () => {
  it('adds from a named list, adds all, and creates a list', () => {
    renderStore(<AccountLists />);
    const page = main();
    expect(
      within(page).getByText('Items you save for later from your cart appear here.'),
    ).toBeTruthy();
    fireEvent.click(
      within(page).getByRole('button', { name: 'Add Free-range chicken, whole to cart' }),
    );
    expect(cartCount()).toBe(1);
    fireEvent.click(within(page).getByRole('button', { name: 'Add all to cart' }));
    expect(cartCount()).toBe(4);
    fireEvent.click(within(page).getByRole('button', { name: 'Create a list' }));
    fireEvent.change(within(page).getByLabelText('List name'), { target: { value: 'Eid dinner' } });
    fireEvent.click(within(page).getByRole('button', { name: 'Create list' }));
    expect(within(page).getByRole('heading', { name: 'Eid dinner (0)' })).toBeTruthy();
  });
});

describe('settings', () => {
  it('has the five sections and no Delete account', () => {
    renderStore(<AccountSettings palette="B" textSize="auto" />);
    const page = main();
    const titles = within(page)
      .getAllByRole('heading', { level: 2 })
      .map((h) => h.textContent);
    expect(titles).toEqual(['Profile', 'Password', 'Appearance', 'Emails', 'Privacy and data']);
    expect(page.textContent).not.toMatch(/delete account/i);
    expect(within(page).getByRole('switch', { name: 'Order updates' })).toHaveProperty(
      'disabled',
      true,
    );
  });

  it('saves a look change to the account and says so', async () => {
    renderStore(<AccountSettings palette="B" textSize="auto" />);
    const page = main();
    expect(within(page).getByText(/Saved to your account/)).toBeTruthy();
    fireEvent.click(within(page).getByRole('button', { name: 'Large' }));
    await waitFor(() =>
      expect(
        within(page)
          .getAllByRole('status')
          .some((s) => s.textContent === 'Appearance saved to your account'),
      ).toBe(true),
    );
  });

  it('checks the new password before it says it was updated', () => {
    renderStore(<AccountSettings palette="B" textSize="auto" />);
    const page = main();
    const type = (label: string, text: string) =>
      fireEvent.change(within(page).getByLabelText(label), { target: { value: text } });
    const update = () =>
      fireEvent.click(within(page).getByRole('button', { name: 'Update password' }));
    type('Current password', 'old-password');
    type('New password', 'short');
    type('Confirm new password', 'short');
    update();
    expect(within(page).getByText('Use at least 10 characters.')).toBeTruthy();
    type('New password', 'a-longer-password');
    update();
    expect(within(page).getByText('The passwords do not match.')).toBeTruthy();
    type('Confirm new password', 'a-longer-password');
    update();
    expect(within(page).getByText('Your password has been updated.')).toBeTruthy();
  });
});
