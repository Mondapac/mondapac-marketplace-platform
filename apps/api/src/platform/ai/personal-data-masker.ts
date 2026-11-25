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
// A calendar date or a date-time prefix (2026-11-25): a date, never a phone number.
const ISO_DATE = /^\p{Nd}{4}-\p{Nd}{2}-\p{Nd}{2}$/u;

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
  const digits = (run.match(DIGIT) ?? []).join('');
  const count = [...digits].length;
  if (ISO_DATE.test(run)) return run;
  // A payment card number: 13 to 19 digits passing the Luhn check (in any other script's digits,
  // where the check is not computed, every such run is masked: fail closed).
  if (count >= 13 && count <= 19 && (!ASCII_DIGITS.test(digits) || luhn(digits))) return MASKED;
  // A phone number: 8 to 15 digits written as one (a leading + or grouped with separators). A
  // bare run of digits is left alone: order numbers and other references are data a capability may
  // need, and the field allow-list, not this mask, keeps phones out (ADR-0019 decision 3).
  const written = run.startsWith('+') || /[ ().-]/u.test(run);
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

function maskBlock(block: ModelBlock): ModelBlock {
  if (block.type === 'text') return { ...block, text: maskPersonalData(block.text) };
  if (block.type === 'tool-result') return { ...block, content: maskPersonalData(block.content) };
  // A tool call is the model's own structured request, sent back as it came.
  return block;
}

/**
 * The request with every message part masked: user and assistant text and tool results. The
 * system text is the capability's own fixed instructions, never user data, and stays as written.
 */
export function maskRequest(request: ModelRequest): ModelRequest {
  const messages: ModelMessage[] = request.messages.map((message) => ({
    role: message.role,
    blocks: message.blocks.map(maskBlock),
  }));
  return { ...request, messages };
}
