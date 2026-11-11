// The street address a signed-in buyer chose in the Deliver to modal and asked to save: handed to
// the address book's Add form for this tab only (sessionStorage), read once and removed. It never
// goes in the URL, so it is not in history, logs or analytics.

const KEY = 'sf-address-prefill';

export interface AddressPrefill {
  readonly street: string;
  readonly suburb: string;
  readonly postcode: string;
}

const field = (value: unknown) => (typeof value === 'string' && value.length <= 120 ? value : null);

export function writeAddressPrefill(prefill: AddressPrefill): boolean {
  try {
    sessionStorage.setItem(KEY, JSON.stringify(prefill));
    return true;
  } catch {
    return false;
  }
}

/** The address waiting for the Add form, removed as it is read; null when there is none. */
export function takeAddressPrefill(): AddressPrefill | null {
  let raw: string | null;
  try {
    raw = sessionStorage.getItem(KEY);
    sessionStorage.removeItem(KEY);
  } catch {
    return null;
  }
  if (raw === null) return null;
  try {
    const value = JSON.parse(raw) as Record<string, unknown> | null;
    const street = field(value?.['street']);
    const suburb = field(value?.['suburb']);
    const postcode = field(value?.['postcode']);
    return street && suburb && postcode ? { street, suburb, postcode } : null;
  } catch {
    return null;
  }
}
