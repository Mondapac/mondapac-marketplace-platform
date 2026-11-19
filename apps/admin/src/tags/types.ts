// Answers of the admin topic routes (apps/api topic.dto.ts), shown in the panel as "Tags", and
// the limits of their fields. Text is what an admin typed: rendered as plain text only.

export const READ_PERMISSION = 'catalog.topic.read';
export const MANAGE_PERMISSION = 'catalog.topic.manage';
export const TAGS_PATH = '/catalog/tags';
export const API_TOPICS = 'catalog/admin/topics';
export const PAGE_SIZE = 25;
export const TERM_MIN = 2;
export const TERM_MAX = 40;
export const INTRO_MAX = 1000;
export const SLUG_MAX = 40;
/** The API's limit per language; the list answer carries the current value as `maxSynonyms`. */
export const SYNONYMS_MAX = 10;

export type TopicStatus = 'active' | 'archived';
export type TopicGroup = 'occasion' | 'cuisine' | 'use';
export const TOPIC_GROUPS: readonly TopicGroup[] = ['occasion', 'cuisine', 'use'];
export type StatusFilter = 'all' | TopicStatus;
export type GroupFilter = 'all' | TopicGroup;

export interface TopicRow {
  readonly id: string;
  readonly slug: string;
  readonly group: TopicGroup;
  readonly status: TopicStatus;
  /** The name by locale; the Market default locale is always present. */
  readonly names: Readonly<Record<string, string>>;
  /** The synonyms by locale, in the order the admin gave them. */
  readonly synonyms: Readonly<Record<string, readonly string[]>>;
  readonly intro: string | null;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly version: number;
}

export interface Locales {
  readonly default: string;
  readonly supported: readonly string[];
}

export interface TopicPage {
  readonly items: readonly TopicRow[];
  readonly nextAfterId: string | null;
  readonly locales: Locales;
  readonly groups: readonly string[];
  readonly maxSynonyms: number;
}

export interface TopicWrap {
  readonly topic: TopicRow;
}
