// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { NextIntlClientProvider } from 'next-intl';
import { useEffect } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import messages from '../messages/en.json';
import { DeliverModal } from '../src/delivery/deliver-modal.tsx';
import { deliverToOf, deliverToValue } from '../src/delivery/deliver-to.ts';
import { insideArea } from '../src/delivery/geo.ts';
import { sampleLookup } from '../src/delivery/lookup.ts';
import { Header } from '../src/shell/header.tsx';
import { StoreProvider, useStore } from '../src/shell/store-context.tsx';
import { SAMPLE_CHECKOUT } from '../src/storefront/sample-cart.ts';
import { SAMPLE_DELIVERY_LOCATOR as SOURCE } from '../src/storefront/sample-delivery.ts';
import type { DeliverTo } from '../src/delivery/deliver-to.ts';

const refresh = vi.fn();
vi.mock('next/navigation', () => ({
  usePathname: () => '/',
  useSearchParams: () => new URLSearchParams(),
  useRouter: () => ({ push: () => undefined, replace: () => undefined, refresh }),
}));

let narrow = false;
beforeEach(() => {
  narrow = false;
  refresh.mockReset();
  document.cookie = 'sf-deliver-to=; Max-Age=0; Path=/';
  window.matchMedia = ((query: string) => ({
    matches: query.includes('max-width: 760px') && narrow,
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
  })) as unknown as typeof window.matchMedia;
  // jsdom lays nothing out; the focus trap skips elements without boxes.
  Element.prototype.getClientRects = function () {
    return [{}] as unknown as DOMRectList;
  };
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

function SignIn() {
  const { setCustomer } = useStore();
  useEffect(() => setCustomer(SAMPLE_CHECKOUT.customer), [setCustomer]);
  return null;
}

function renderHeader({
  signedIn = false,
  deliverTo = null,
}: { signedIn?: boolean; deliverTo?: DeliverTo | null } = {}) {
  return render(
    <NextIntlClientProvider locale="en" messages={messages} timeZone="UTC">
      <StoreProvider initialDeliverTo={deliverTo}>
        {signedIn ? <SignIn /> : null}
        <Header delivery={{ label: 'Brisbane 4000' }} />
        <DeliverModal source={SOURCE} />
      </StoreProvider>
    </NextIntlClientProvider>,
  );
}

/** Runs an event and lets the stubbed lookup's promises settle. */
async function settle(run: () => void) {
  await act(async () => {
    run();
    await Promise.resolve();
  });
}

const deliverButton = () => screen.getByRole('button', { name: /^Delivery area/ });

async function openModal() {
  await settle(() => fireEvent.click(deliverButton()));
  return screen.getByRole('dialog', { name: 'Choose where to deliver' });
}

async function type(text: string) {
  await settle(() =>
    fireEvent.change(screen.getByRole('combobox', { name: 'Search your address' }), {
      target: { value: text },
    }),
  );
}

const summary = (dialog: HTMLElement) => dialog.querySelector('.lmsel') as HTMLElement;
const confirmButton = () => screen.getByRole('button', { name: 'Confirm location' });

function geolocation(answer: (ok: PositionCallback, fail: PositionErrorCallback) => void) {
  const getCurrentPosition = vi.fn(answer);
  vi.stubGlobal('navigator', { ...navigator, geolocation: { getCurrentPosition } });
  return getCurrentPosition;
}

describe('delivery location cookie', () => {
  it('reads back what it wrote, suburb and postcode only', () => {
    const value = deliverToValue({ suburb: 'Mt Gravatt', postcode: '4122' });
    expect(deliverToOf(value)).toEqual({ suburb: 'Mt Gravatt', postcode: '4122' });
  });

  it('ignores values it did not write', () => {
    for (const value of [undefined, '', 'Kedron', 'Kedron|4031|x', '<b>|4031', 'Kedron|%E0%A4%A'])
      expect(deliverToOf(value), String(value)).toBeNull();
  });
});

describe('sample address lookup', () => {
  const lookup = sampleLookup(SOURCE);

  it('finds addresses that contain every word typed', async () => {
    expect((await lookup.search('example kedron')).map((p) => p.street)).toEqual([
      '12 Example Street',
    ]);
    expect(await lookup.search('nowhere street')).toEqual([]);
  });

  it('finds a suburb chosen before by its name and postcode', async () => {
    expect((await lookup.locate({ suburb: 'Kedron', postcode: '4031' }))?.suburb).toBe('Kedron');
    expect((await lookup.locate({ suburb: 'Brisbane', postcode: '4000' }))?.suburb).toBe(
      'Brisbane City',
    );
    expect(await lookup.locate({ suburb: 'Perth', postcode: '6000' })).toBeNull();
  });

  it('places the sample suburbs inside the area and the outer address outside it', () => {
    for (const suburb of SOURCE.suburbs)
      expect(insideArea(suburb.point, SOURCE.area.boundary), suburb.suburb).toBe(true);
    const outer = SOURCE.addresses.find((p) => p.suburb === 'Toowoomba')!;
    expect(insideArea(outer.point, SOURCE.area.boundary)).toBe(false);
  });
});

describe('Deliver to modal', () => {
  it('opens from the header button with focus in the search box', async () => {
    renderHeader();
    expect(deliverButton().getAttribute('aria-expanded')).toBe('false');
    const dialog = await openModal();
    expect(deliverButton().getAttribute('aria-expanded')).toBe('true');
    expect(document.activeElement).toBe(within(dialog).getByRole('combobox'));
    expect(summary(dialog).textContent).toContain('Brisbane City QLD 4000');
    expect(summary(dialog).textContent).toContain('We deliver to this area');
    expect(dialog.textContent).toContain('Log in to choose one of your saved addresses.');
    expect(dialog.textContent).toContain('we keep only your suburb and postcode in this browser');
  });

  it('starts on the close button on narrow screens', async () => {
    narrow = true;
    renderHeader();
    const dialog = await openModal();
    expect(document.activeElement).toBe(dialog.querySelector('.lmx'));
  });

  it('picks a suggestion with the keyboard and confirms it into the header', async () => {
    renderHeader();
    const dialog = await openModal();
    await type('kedron');
    const box = within(dialog).getByRole('combobox');
    expect(box.getAttribute('aria-expanded')).toBe('true');
    const options = within(dialog).getAllByRole('option');
    expect(options[0]!.textContent).toContain('12 Example Street');
    expect(options[0]!.textContent).toContain('Kedron QLD 4031');
    fireEvent.keyDown(box, { key: 'ArrowDown' });
    expect(box.getAttribute('aria-activedescendant')).toBe(options[0]!.id);
    await settle(() => fireEvent.keyDown(box, { key: 'Enter' }));
    expect(within(dialog).queryByRole('listbox')).toBeNull();
    expect(summary(dialog).textContent).toContain('12 Example Street, Kedron QLD 4031');
    await settle(() => fireEvent.click(confirmButton()));
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(deliverButton().textContent).toContain('Kedron 4031');
    expect(document.activeElement).toBe(deliverButton());
    expect(document.cookie).toContain('sf-deliver-to=Kedron|4031');
    expect(refresh).toHaveBeenCalledTimes(1);
  });

  it('says when nothing matches, and Esc closes the list before the modal', async () => {
    renderHeader();
    const dialog = await openModal();
    await type('zzz');
    expect(within(dialog).getByRole('option').textContent).toContain(
      'No match. Try the street and suburb.',
    );
    fireEvent.keyDown(within(dialog).getByRole('combobox'), { key: 'Escape' });
    expect(within(dialog).queryByRole('listbox')).toBeNull();
    expect(screen.getByRole('dialog')).not.toBeNull();
    fireEvent.keyDown(within(dialog).getByRole('combobox'), { key: 'Escape' });
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(document.activeElement).toBe(deliverButton());
  });

  it('refuses an address outside the delivery area', async () => {
    renderHeader();
    const dialog = await openModal();
    await type('toowoomba');
    await settle(() => fireEvent.click(within(dialog).getByRole('option')));
    expect(summary(dialog).textContent).toContain(
      'We do not deliver here yet. We currently deliver to Greater Brisbane.',
    );
    expect(dialog.querySelector('.lmpin')?.classList.contains('out')).toBe(true);
    expect(confirmButton().getAttribute('aria-disabled')).toBe('true');
    await settle(() => fireEvent.click(confirmButton()));
    expect(screen.getByRole('dialog')).not.toBeNull();
    expect(deliverButton().textContent).toContain('Brisbane 4000');
  });

  it('moves the pin with the arrow keys', async () => {
    renderHeader();
    const dialog = await openModal();
    const pin = within(dialog).getByRole('button', {
      name: 'Delivery pin. Use arrow keys to move it.',
    });
    await settle(() => fireEvent.keyDown(pin, { key: 'ArrowUp' }));
    expect(summary(dialog).textContent).toContain('Dropped pin near Brisbane City QLD 4000');
    for (let i = 0; i < 40; i++) await settle(() => fireEvent.keyDown(pin, { key: 'ArrowUp' }));
    expect(summary(dialog).textContent).toContain('Dropped pin outside Greater Brisbane');
    expect(confirmButton().getAttribute('aria-disabled')).toBe('true');
  });

  it('asks for the device location only on tap and shows where it is', async () => {
    const kedron = SOURCE.suburbs.find((s) => s.suburb === 'Kedron')!.point;
    const asked = geolocation((ok) =>
      ok({ coords: { latitude: kedron.lat, longitude: kedron.lng } } as GeolocationPosition),
    );
    renderHeader();
    const dialog = await openModal();
    expect(asked).not.toHaveBeenCalled();
    await settle(() =>
      fireEvent.click(within(dialog).getByRole('button', { name: 'Use my current location' })),
    );
    expect(summary(dialog).textContent).toContain('Near Kedron QLD 4031');
    expect(summary(dialog).textContent).toContain('Based on your device location.');
    expect(dialog.querySelector('.mring')).not.toBeNull();
  });

  it('shows the busy state while the device location is found', async () => {
    geolocation(() => undefined);
    renderHeader();
    const dialog = await openModal();
    await settle(() =>
      fireEvent.click(within(dialog).getByRole('button', { name: 'Use my current location' })),
    );
    const busy = within(dialog).getByRole('button', { name: 'Finding your location' });
    expect(busy.getAttribute('aria-busy')).toBe('true');
  });

  it('explains a blocked and a failed device location', async () => {
    const answer = { code: 1 };
    geolocation((_ok, fail) =>
      fail({ ...answer, PERMISSION_DENIED: 1 } as unknown as GeolocationPositionError),
    );
    renderHeader();
    const dialog = await openModal();
    const button = within(dialog).getByRole('button', { name: 'Use my current location' });
    await settle(() => fireEvent.click(button));
    expect(within(dialog).getByRole('alert').textContent).toContain(
      'Location access is blocked for this site.',
    );
    answer.code = 3;
    await settle(() => fireEvent.click(button));
    expect(within(dialog).getByRole('alert').textContent).toContain(
      'We could not find your location.',
    );
  });

  it('offers the saved addresses when signed in', async () => {
    renderHeader({ signedIn: true });
    const dialog = await openModal();
    expect(dialog.textContent).toContain('Your delivery location is saved to your account.');
    const work = within(dialog).getByRole('radio', { name: /Work/ });
    await settle(() => fireEvent.click(work));
    expect((work as HTMLInputElement).checked).toBe(true);
    expect(summary(dialog).textContent).toContain(
      'Level 3, 100 Sample Road, Brisbane City QLD 4000',
    );
  });

  it('starts from the suburb kept in this browser', async () => {
    renderHeader({ deliverTo: { suburb: 'Sunnybank', postcode: '4109' } });
    expect(deliverButton().textContent).toContain('Sunnybank 4109');
    const dialog = await openModal();
    expect(summary(dialog).textContent).toContain('Sunnybank QLD 4109');
  });

  it('keeps Tab inside the dialog', async () => {
    renderHeader();
    const dialog = await openModal();
    const close = within(dialog).getAllByRole('button', { name: 'Close' })[0]!;
    const last = dialog.querySelectorAll('button');
    const lastButton = last[last.length - 1]!;
    lastButton.focus();
    fireEvent.keyDown(lastButton, { key: 'Tab' });
    expect(document.activeElement).toBe(close);
    fireEvent.keyDown(close, { key: 'Tab', shiftKey: true });
    expect(document.activeElement).toBe(lastButton);
  });
});
