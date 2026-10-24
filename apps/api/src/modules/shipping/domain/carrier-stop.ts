// The checks on one end of a carrier trip before it leaves for the carrier. The bounds are the
// carrier API's (Mondapac Drive: address up to 300 characters, contact name up to 120, phone
// digits and spaces with an optional leading plus, postcode 3 to 10 letters, digits, spaces or
// hyphens, notes up to 500). Values are never echoed in a failure: only the field path.

export interface CarrierStopInput {
  readonly contactName: string;
  readonly contactPhone: string;
  readonly addressLines: readonly string[];
  readonly postcode: string;
  readonly notes: string | null;
}

const PHONE = /^\+?[0-9 ]{6,20}$/;
const POSTCODE = /^[0-9A-Za-z -]{3,10}$/;
const MAX_NAME = 120;
const MAX_ADDRESS = 300;
const MAX_NOTES = 500;
const MAX_LINES = 8;
// No control characters: the text is sent as JSON, but a line break would mangle a label.
const CONTROL = /\p{Cc}/u;

const text = (value: unknown): string | null =>
  typeof value === 'string' && !CONTROL.test(value) ? value.normalize('NFC').trim() : null;

/** The carrier's single address line: the non-empty lines joined with ", ". */
export const addressLineOf = (stop: CarrierStopInput): string =>
  stop.addressLines.filter((line) => line !== '').join(', ');

/**
 * One end of a trip from another module, checked: a contact name of 1 to 120 characters, a phone
 * the carrier accepts (brackets, dots and hyphens dropped), at least one address line and at most
 * {@link MAX_LINES}, 3 to 300 characters joined, a postcode the carrier accepts and optional
 * notes up to 500. Fields are trimmed; an empty line is dropped.
 */
export function parseCarrierStop(
  input: unknown,
  path: string,
):
  | { readonly ok: true; readonly stop: CarrierStopInput }
  | { readonly ok: false; readonly fields: readonly { path: string; code: string }[] } {
  const value = (typeof input === 'object' && input !== null ? input : {}) as Record<
    string,
    unknown
  >;
  const fields: { path: string; code: string }[] = [];
  const contactName = text(value.contactName);
  if (contactName === null || contactName.length === 0 || contactName.length > MAX_NAME) {
    fields.push({ path: `${path}.contactName`, code: 'format' });
  }
  // Brackets, dots and hyphens people type in a number are dropped; the digits stay.
  const contactPhone = text(value.contactPhone)?.replace(/[().-]/gu, '') ?? null;
  if (contactPhone === null || !PHONE.test(contactPhone)) {
    fields.push({ path: `${path}.contactPhone`, code: 'format' });
  }
  const rawLines = Array.isArray(value.addressLines) ? (value.addressLines as unknown[]) : null;
  const lines = rawLines?.map(text) ?? null;
  const addressLines =
    lines === null || lines.some((line) => line === null)
      ? null
      : (lines as string[]).filter((line) => line !== '');
  const joined = addressLines?.join(', ') ?? '';
  if (
    addressLines === null ||
    addressLines.length === 0 ||
    addressLines.length > MAX_LINES ||
    joined.length < 3 ||
    joined.length > MAX_ADDRESS
  ) {
    fields.push({ path: `${path}.addressLines`, code: 'format' });
  }
  const postcode = text(value.postcode);
  if (postcode === null || !POSTCODE.test(postcode)) {
    fields.push({ path: `${path}.postcode`, code: 'format' });
  }
  let notes: string | null = null;
  if (value.notes !== undefined && value.notes !== null && value.notes !== '') {
    // A customer's notes may hold line breaks: they become spaces, never a refusal.
    notes =
      typeof value.notes === 'string'
        ? value.notes
            .replace(/\p{Cc}+/gu, ' ')
            .normalize('NFC')
            .trim()
        : null;
    if (notes === null || notes.length > MAX_NOTES) {
      fields.push({ path: `${path}.notes`, code: 'format' });
    }
  }
  if (fields.length > 0) return { ok: false, fields };
  return {
    ok: true,
    stop: {
      contactName: contactName!,
      contactPhone: contactPhone!,
      addressLines: addressLines!,
      postcode: postcode!,
      notes: notes === '' ? null : notes,
    },
  };
}
