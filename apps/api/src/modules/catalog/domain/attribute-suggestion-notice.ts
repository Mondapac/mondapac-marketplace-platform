import type { SuggestionStatus } from './attribute-value-suggestion';

// The one plain-text mail that tells a seller what became of their value suggestion (attributes
// plan, package A5). English, as the panels are; no link, no HTML. The seller's own text and the
// reviewer's reason are quoted as plain text; nothing else of the product or the seller is named.

export interface SuggestionNoticeFacts {
  readonly status: Exclude<SuggestionStatus, 'open'>;
  /** The attribute's name in the Market's default locale (its code when it has none). */
  readonly attributeName: string;
  /** What the seller asked for. */
  readonly label: string;
  /** The value now on the list, in the default locale (approved and mapped). */
  readonly optionLabel: string | null;
  /** The reviewer's words (rejected). */
  readonly reason: string | null;
}

export interface SuggestionNoticeMail {
  readonly subject: string;
  readonly text: string;
}

export function suggestionNoticeMail(facts: SuggestionNoticeFacts): SuggestionNoticeMail {
  const asked = `You asked for the value "${facts.label}" on the field "${facts.attributeName}".`;
  if (facts.status === 'approved') {
    return {
      subject: `Your suggested value was added to "${facts.attributeName}"`,
      text: [
        asked,
        '',
        `It was added to the list as "${facts.optionLabel ?? facts.label}". Open your product in the seller panel and choose it.`,
      ].join('\n'),
    };
  }
  if (facts.status === 'mapped') {
    return {
      subject: `A value on "${facts.attributeName}" covers your suggestion`,
      text: [
        asked,
        '',
        `The list already has "${facts.optionLabel ?? ''}", which fits. Open your product in the seller panel and choose it.`,
      ].join('\n'),
    };
  }
  return {
    subject: `Your suggested value for "${facts.attributeName}" was not added`,
    text: [
      asked,
      '',
      'It was not added to the list.',
      ...(facts.reason === null ? [] : ['', `Reason: ${facts.reason}`]),
      '',
      'You can choose another value from the list, or suggest a different one.',
    ].join('\n'),
  };
}
