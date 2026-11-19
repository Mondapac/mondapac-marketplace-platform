import { err, ok, parsePlainText } from '@mondapac/shared-kernel';
import type { Result } from '@mondapac/shared-kernel';

/**
 * What the "Write with AI" modal sends (AIS-03; catalog design 13.1 as changed for the modal, see
 * the brief's change log of 2026-11-13). This is the whole field allow-list of the capability
 * (ADR-0019 R5): the form's own title, category label and product details as the writer sees
 * them, plus the keywords and the short note typed in the modal. Never images, prices, tags,
 * handling, attestation, tax category, another seller's data or reviewer text: the server adds
 * nothing to it. Every text is the caller's own and is data, never instructions (R9).
 */

export const WRITER_TONES = ['clear-friendly', 'simple-factual', 'warm'] as const;
export type WriterTone = (typeof WRITER_TONES)[number];

/** About how many words the draft has. */
export const WRITER_LENGTHS = [50, 80, 150] as const;
export type WriterLength = (typeof WRITER_LENGTHS)[number];

export const MAX_KEYWORDS = 10;
export const MAX_KEYWORD_CHARS = 40;
export const MAX_NOTE_CHARS = 300;
export const MAX_TITLE_CHARS = 200;
export const MAX_CATEGORY_CHARS = 200;
export const MAX_DETAILS = 20;
export const MAX_DETAIL_NAME_CHARS = 60;
export const MAX_DETAIL_VALUE_CHARS = 120;

export interface WriterDetail {
  readonly name: string;
  readonly value: string;
}

export interface WriterRequest {
  readonly title: string;
  readonly category: string;
  readonly details: readonly WriterDetail[];
  readonly keywords: readonly string[];
  /** Empty when the writer gave none. */
  readonly note: string;
  readonly tone: WriterTone;
  readonly length: WriterLength;
}

export interface WriterFieldIssue {
  readonly path: string;
  readonly code: string;
}

const BODY_KEYS = ['category', 'details', 'keywords', 'length', 'note', 'title', 'tone'] as const;
const DETAIL_KEYS = ['name', 'value'] as const;

/** One line of text: plain, trimmed, inner runs of white space folded to one space. */
function line(
  value: unknown,
  path: string,
  max: number,
  required: boolean,
  issues: WriterFieldIssue[],
): string {
  if (value === undefined || value === null) {
    if (required) issues.push({ path, code: 'required' });
    return '';
  }
  if (typeof value !== 'string') {
    issues.push({ path, code: 'type' });
    return '';
  }
  const plain = parsePlainText(value);
  if (!plain.ok) {
    issues.push({ path, code: plain.error.code });
    return '';
  }
  const text = value.replace(/\s+/gu, ' ').trim();
  if (text.length === 0 && required) issues.push({ path, code: 'required' });
  else if (text.length > max) issues.push({ path, code: 'too-long' });
  return text;
}

function closedKeys(
  value: object,
  allowed: readonly string[],
  prefix: string,
  issues: WriterFieldIssue[],
): void {
  for (const key of Object.keys(value).sort()) {
    if (!allowed.includes(key)) {
      issues.push({ path: `${prefix}${key.slice(0, 64)}`, code: 'unknown-field' });
    }
  }
}

/**
 * Checks the body as it came (a closed object; every text plain, without invisible characters,
 * within its bound). The title and the category are required: without them the modal is in its
 * "Add a title and category first." state and never sends.
 */
export function parseWriterRequest(
  body: unknown,
): Result<WriterRequest, readonly WriterFieldIssue[]> {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) {
    return err([{ path: '', code: 'type' }]);
  }
  const issues: WriterFieldIssue[] = [];
  closedKeys(body, BODY_KEYS, '', issues);
  const raw = body as Record<string, unknown>;

  const title = line(raw.title, 'title', MAX_TITLE_CHARS, true, issues);
  const category = line(raw.category, 'category', MAX_CATEGORY_CHARS, true, issues);
  const note = line(raw.note, 'note', MAX_NOTE_CHARS, false, issues);

  const keywords: string[] = [];
  if (raw.keywords !== undefined) {
    if (!Array.isArray(raw.keywords)) issues.push({ path: 'keywords', code: 'type' });
    else if (raw.keywords.length > MAX_KEYWORDS) {
      issues.push({ path: 'keywords', code: 'too-many' });
    } else {
      raw.keywords.forEach((keyword: unknown, index) => {
        const text = line(keyword, `keywords.${index}`, MAX_KEYWORD_CHARS, true, issues);
        if (text.length > 0) keywords.push(text);
      });
    }
  }

  const details: WriterDetail[] = [];
  if (raw.details !== undefined) {
    if (!Array.isArray(raw.details)) issues.push({ path: 'details', code: 'type' });
    else if (raw.details.length > MAX_DETAILS) issues.push({ path: 'details', code: 'too-many' });
    else {
      raw.details.forEach((detail: unknown, index) => {
        const path = `details.${index}`;
        if (typeof detail !== 'object' || detail === null || Array.isArray(detail)) {
          issues.push({ path, code: 'type' });
          return;
        }
        closedKeys(detail, DETAIL_KEYS, `${path}.`, issues);
        const record = detail as Record<string, unknown>;
        const name = line(record.name, `${path}.name`, MAX_DETAIL_NAME_CHARS, true, issues);
        const value = line(record.value, `${path}.value`, MAX_DETAIL_VALUE_CHARS, true, issues);
        if (name.length > 0 && value.length > 0) details.push({ name, value });
      });
    }
  }

  const tone = raw.tone === undefined ? 'clear-friendly' : raw.tone;
  if (typeof tone !== 'string' || !(WRITER_TONES as readonly string[]).includes(tone)) {
    issues.push({ path: 'tone', code: 'not-allowed' });
  }
  const length = raw.length === undefined ? 80 : raw.length;
  if (typeof length !== 'number' || !(WRITER_LENGTHS as readonly number[]).includes(length)) {
    issues.push({ path: 'length', code: 'not-allowed' });
  }

  if (issues.length > 0) return err(issues);
  return ok({
    title,
    category,
    details,
    keywords,
    note,
    tone: tone as WriterTone,
    length: length as WriterLength,
  });
}
