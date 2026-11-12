import type { SuggestionStatus } from './topic-suggestion';

// The one plain-text mail that tells a seller what became of their tag suggestion (product tags
// package T5). English, as the panels are; no link, no HTML. The seller's own text and the
// reviewer's reason are quoted as plain text; nothing else of the product or the seller is named.

export interface TopicSuggestionNoticeFacts {
  readonly status: Exclude<SuggestionStatus, 'open'>;
  /** What the seller asked for. */
  readonly label: string;
  /** The tag now on the list, in the default locale (approved and mapped). */
  readonly topicName: string | null;
  /** The reviewer's words (rejected). */
  readonly reason: string | null;
}

export interface TopicSuggestionNoticeMail {
  readonly subject: string;
  readonly text: string;
}

export function topicSuggestionNoticeMail(
  facts: TopicSuggestionNoticeFacts,
): TopicSuggestionNoticeMail {
  const asked = `You asked for the tag "${facts.label}".`;
  const name = facts.topicName ?? facts.label;
  if (facts.status === 'approved') {
    return {
      subject: 'Your suggested tag was added',
      text: [
        asked,
        '',
        `It was added to the list as "${name}". Open your product in the seller panel and add it. Changes to tags are checked by us before they go live.`,
      ].join('\n'),
    };
  }
  if (facts.status === 'mapped') {
    return {
      subject: 'A tag on the list covers your suggestion',
      text: [
        asked,
        '',
        `The list already has "${name}", which fits. Open your product in the seller panel and add it. Changes to tags are checked by us before they go live.`,
      ].join('\n'),
    };
  }
  return {
    subject: 'Your suggested tag was not added',
    text: [
      asked,
      '',
      'It was not added to the list.',
      ...(facts.reason === null ? [] : ['', `Reason: ${facts.reason}`]),
      '',
      'You can pick another tag from the list, or suggest a different one.',
    ].join('\n'),
  };
}
