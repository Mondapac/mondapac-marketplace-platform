// The delivery location shown in the header. A guest keeps only the suburb and postcode, in a
// cookie of this browser so the server renders the label on the first paint; no exact address or
// coordinates are kept (default proposed in handoffs/deliver-to-modal.md, not yet confirmed by
// john). Saving it to a signed-in customer's account needs the backend and is not built.

export const DELIVER_TO_COOKIE = 'sf-deliver-to';

export interface DeliverTo {
  readonly suburb: string;
  readonly postcode: string;
}

const SUBURB = /^[\p{L}\p{M} .'-]{1,60}$/u;
const POSTCODE = /^[\p{L}\p{N} -]{2,10}$/u;

/** The cookie's value as a location, or null when it is missing or not one we wrote. */
export function deliverToOf(value: string | undefined): DeliverTo | null {
  if (!value) return null;
  const parts = value.split('|');
  if (parts.length !== 2) return null;
  try {
    const [suburb, postcode] = parts.map((part) => decodeURIComponent(part));
    if (!SUBURB.test(suburb!) || !POSTCODE.test(postcode!)) return null;
    return { suburb: suburb!, postcode: postcode! };
  } catch {
    return null;
  }
}

export function deliverToValue({ suburb, postcode }: DeliverTo): string {
  return `${encodeURIComponent(suburb)}|${encodeURIComponent(postcode)}`;
}

/** "Kedron 4031": the header's label. */
export function deliverToLabel(to: DeliverTo): string {
  return `${to.suburb} ${to.postcode}`;
}

const YEAR = 60 * 60 * 24 * 365;

export function saveDeliverTo(to: DeliverTo) {
  document.cookie = `${DELIVER_TO_COOKIE}=${deliverToValue(to)}; Path=/; Max-Age=${YEAR}; SameSite=Lax; Secure`;
}
