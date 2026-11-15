// The words and limits of the "Write with AI" modal (catalog design 13.1, screen 61 papAiModal).
// The panels are English only (CLAUDE.md), so the copy lives here, once, for both panels. The
// limits mirror the API's closed input schema (apps/api writer-request.ts).

export const MAX_KEYWORDS = 10;
export const MAX_KEYWORD_CHARS = 40;
export const MAX_NOTE_CHARS = 300;
export const MAX_TITLE_CHARS = 200;
export const MAX_CATEGORY_CHARS = 200;
export const MAX_DETAILS = 20;
export const MAX_DETAIL_NAME_CHARS = 60;
export const MAX_DETAIL_VALUE_CHARS = 120;

export const WRITER_TONES = ['clear-friendly', 'simple-factual', 'warm'] as const;
export type WriterTone = (typeof WRITER_TONES)[number];
export const WRITER_LENGTHS = [50, 80, 150] as const;
export type WriterLength = (typeof WRITER_LENGTHS)[number];

export interface LeftOut {
  readonly certification: number;
  readonly other: number;
}

export const WRITER_COPY = {
  button: 'Write with AI',
  buttonBusy: 'Writing…',
  title: 'Write description with AI',
  intro:
    'Give a few keywords and a short note. The draft uses only what you give and what the form already says.',
  close: 'Close',
  keywords: 'Keywords',
  keywordsHelp: 'Up to 10. Words you want in the text.',
  keywordsPlaceholder: 'Type a word and press Enter',
  keywordsFull: '10 of 10',
  removeKeyword: (word: string) => `Remove ${word}`,
  note: 'Short note',
  noteHelp: 'Up to 300 characters. Certifications come from seller offers, not from the text.',
  tone: 'Tone',
  length: 'Length',
  tones: {
    'clear-friendly': 'Clear and friendly',
    'simple-factual': 'Simple and factual',
    warm: 'Warm',
  } satisfies Record<WriterTone, string>,
  lengths: {
    50: 'About 50 words',
    80: 'About 80 words',
    150: 'About 150 words',
  } satisfies Record<WriterLength, string>,
  usedHeading: 'Also used, from the form',
  usedTitle: 'Title',
  usedCategory: 'Category',
  usedDetails: 'Product details',
  missing: 'Missing',
  none: '—',
  usedNote: 'Change these in the form. Images aren’t sent.',
  blocked: 'Add a title and category first.',
  cancel: 'Cancel',
  generate: 'Generate',
  tryAgain: 'Try again',
  stop: 'Stop',
  writing: 'Writing a draft… It takes a few seconds. Closing this keeps your form as it is.',
  draftLabel: 'Draft · check it before you use it',
  existing: 'The description already has text',
  replace: 'Replace it',
  append: 'Add below it',
  back: 'Back to edit',
  use: 'Use text',
  discardTitle: 'Discard this draft?',
  discardBody: 'The draft is not saved anywhere.',
  discardKeep: 'Keep draft',
  discardConfirm: 'Discard',
  failedTitle: 'We couldn’t write a draft.',
  failedBody: 'Try again, or write it yourself. Your form wasn’t changed.',
  throttledTitle: 'Too many requests right now.',
  throttledBody: 'Wait a moment, then try again. Your form wasn’t changed.',
  limitTitle: 'Today’s AI drafts are used up.',
  limitBody: (zone: string) =>
    `They reset at midnight ${zone} time. You can still write the description yourself.`,
  withheldTitle: 'We couldn’t use that draft.',
  withheldBody: 'Change the keywords or the note and try again, or write it yourself.',
} as const;

/** "1 sentence was left out: it named a certification." The reasons come from the API's counts. */
export function leftOutLine(leftOut: LeftOut): string | null {
  const total = leftOut.certification + leftOut.other;
  if (total <= 0) return null;
  const one = total === 1;
  const head = one ? '1 sentence was left out: ' : `${String(total)} sentences were left out: `;
  if (leftOut.certification > 0 && leftOut.other > 0) {
    return `${head}some named a certification, others added details the form doesn’t have.`;
  }
  if (leftOut.certification > 0) {
    return `${head}${one ? 'it named' : 'they named'} a certification.`;
  }
  return `${head}${one ? 'it added' : 'they added'} details the form doesn’t have.`;
}

export interface WriterDetail {
  readonly name: string;
  readonly value: string;
}

const clip = (text: string, max: number): string => [...text.trim()].slice(0, max).join('');

/** The form's details as the API takes them: trimmed, empty ones dropped, clipped, at most 20. */
export function clampDetails(details: readonly WriterDetail[]): WriterDetail[] {
  return details
    .map((d) => ({
      name: clip(d.name, MAX_DETAIL_NAME_CHARS),
      value: clip(d.value, MAX_DETAIL_VALUE_CHARS),
    }))
    .filter((d) => d.name !== '' && d.value !== '')
    .slice(0, MAX_DETAILS);
}

export const clampTitle = (text: string): string => clip(text, MAX_TITLE_CHARS);
export const clampCategory = (text: string): string => clip(text, MAX_CATEGORY_CHARS);
