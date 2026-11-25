import type { ModelBlock, ModelMessage, ModelRequest } from './model-provider';

/** What a masked piece of personal data becomes before a model sees it. */
export const MASKED = '[masked]';

// An email address: a local part, an @, a domain with a dot.
const EMAIL = /[\p{L}\p{N}._%+-]+@[\p{L}\p{N}-]+(?:\.[\p{L}\p{N}-]+)+/gu;
// A number standing alone, not inside a word or a code such as a tracking id or a UUID (so no
// letter, digit or dash-joined part touches either end): digits with at most one separator (space,
// dot, dash, bracket) between two of them, and an optional leading +.
const NUMBER =
  /(?<![\p{L}\p{N}-])\+?\(?\p{Nd}(?:(?:[ .-]|\) ?|\( ?)?\p{Nd})*(?![\p{L}\p{N}]|-[\p{L}\p{N}])/gu;
const DIGIT = /\p{Nd}/gu;
const ASCII_DIGITS = /^[0-9]+$/;
// A calendar date (2026-11-25, 25.11.2026, 25-11-2026), maybe with the hour of a time after it
// ("05.11.2026 10:30" runs up to the colon): a date, never a phone number.
const DATE =
  /^(?:\p{Nd}{4}-\p{Nd}{2}-\p{Nd}{2}|\p{Nd}{1,2}[.-]\p{Nd}{1,2}[.-]\p{Nd}{4})(?: \p{Nd}{1,2})?$/u;
// How a written phone number starts: an international +, a bracketed area code or a trunk zero.
const PHONE_START = /^(?:\+|\(|[0٠۰०০０])/u;

/** Arabic-Indic and Persian digits as ASCII, so the card check runs on them too. */
function asciiDigits(digits: string): string {
  return digits.replace(/[\u0660-\u0669\u06F0-\u06F9]/gu, (d) =>
    String((d.codePointAt(0)! - 0x0660) % 0x90),
  );
}

function luhn(digits: string): boolean {
  let sum = 0;
  for (let i = 0; i < digits.length; i++) {
    let d = digits.charCodeAt(digits.length - 1 - i) - 48;
    if (i % 2 === 1) {
      d *= 2;
      if (d > 9) d -= 9;
    }
    sum += d;
  }
  return sum % 10 === 0;
}

function maskNumber(run: string): string {
  const digits = asciiDigits((run.match(DIGIT) ?? []).join(''));
  const count = [...digits].length;
  if (DATE.test(run)) return run;
  // A payment card number: 13 to 19 digits passing the Luhn check (in a script whose digits are
  // not mapped, every such run is masked: fail closed). About one barcode in ten also passes Luhn
  // and is masked: accepted, the second line of defence errs on the safe side.
  if (count >= 13 && count <= 19 && (!ASCII_DIGITS.test(digits) || luhn(digits))) return MASKED;
  // A phone number: 8 to 15 digits written as one, starting with +, a bracket or a trunk zero and
  // grouped with separators (or after a +). Sizes, prices, dates, model numbers and bare reference
  // numbers are left alone: they are data a capability may need, and the field allow-list, not
  // this mask, keeps phones out (ADR-0019 decision 3).
  const written = run.startsWith('+') || (PHONE_START.test(run) && /[ ().-]/u.test(run));
  if (count >= 8 && count <= 15 && written) return MASKED;
  return run;
}

/**
 * The gateway's generic mask (docs/design/domain/platform-ai.md sections 4 and 9): email
 * addresses, payment card numbers and phone numbers. It is the second line of defence; the
 * control is each capability's field allow-list. Never reversed.
 */
export function maskPersonalData(text: string): string {
  return text.replace(EMAIL, MASKED).replace(NUMBER, maskNumber);
}

/** Every string inside a JSON-like value, masked; the shape is kept. */
function maskValue(value: unknown): unknown {
  if (typeof value === 'string') return maskPersonalData(value);
  if (Array.isArray(value)) return value.map(maskValue);
  if (typeof value === 'object' && value !== null) {
    return Object.fromEntries(Object.entries(value).map(([key, v]) => [key, maskValue(v)]));
  }
  return value;
}

function maskBlock(block: ModelBlock): ModelBlock {
  if (block.type === 'text') return { ...block, text: maskPersonalData(block.text) };
  if (block.type === 'tool-result') return { ...block, content: maskPersonalData(block.content) };
  // A tool call the model made earlier: its arguments' strings too (defence in depth).
  return { ...block, input: maskValue(block.input) };
}

/**
 * The request with every message part masked: user and assistant text, tool calls and tool
 * results. The system text is the capability's own fixed instructions, never user data, and
 * stays as written.
 */
export function maskRequest(request: ModelRequest): ModelRequest {
  const messages: ModelMessage[] = request.messages.map((message) => ({
    role: message.role,
    blocks: message.blocks.map(maskBlock),
  }));
  return { ...request, messages };
}
