// Answers of the admin tag-suggestion routes (apps/api topic-suggestion.dto.ts). The label is the
// seller's own words: plain text, shown as a text node only.

import type { Locales, TopicGroup } from './types.ts';

export const REVIEW_PERMISSION = 'catalog.topic-suggestion.review';
export const SUGGESTIONS_PATH = '/catalog/tags/suggestions';
export const API_TOPIC_SUGGESTIONS = 'catalog/admin/topic-suggestions';
export const REASON_MAX = 300;
export const NAME_MAX = 40;

export interface SuggestionItem {
  readonly id: string;
  readonly version: number;
  readonly label: string;
  readonly createdAt: string;
  readonly sellerId: string;
  readonly productId: string;
  readonly productCode: string | null;
  readonly suggestedSlug: string;
}

export interface SuggestionList {
  readonly items: readonly SuggestionItem[];
  readonly requiredLocales: readonly string[];
  readonly locales: Locales;
}

export interface SuggestionDecided {
  readonly suggestion: {
    readonly id: string;
    readonly status: 'approved' | 'mapped' | 'rejected';
    readonly version: number;
    readonly topicId: string | null;
  };
}

export type { TopicGroup };
