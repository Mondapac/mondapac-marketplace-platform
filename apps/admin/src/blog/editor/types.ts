// Answers and bodies of the admin blog post routes the editor uses (apps/api blog module:
// post-support.ts views, domain/content.ts and domain/body.ts limits). Text is what an editor
// typed: rendered as plain text only.

import type { PostKind, PostStatus } from '../types.ts';

export const LIMITS = {
  title: 120,
  excerpt: 160,
  coverAlt: 200,
  seoTitle: 70,
  seoDescription: 160,
  authorDisplay: 80,
  tags: 10,
  blocks: 200,
  paragraph: 2000,
  heading: 120,
  listItems: 20,
  listItem: 300,
  quote: 600,
  quoteBy: 120,
  tip: 600,
  tipTitle: 60,
} as const;

/** A block of the body as the API stores it. */
export type ApiBlock =
  | { readonly type: 'paragraph'; readonly text: string }
  | { readonly type: 'heading'; readonly level: 2 | 3; readonly text: string }
  | { readonly type: 'list'; readonly ordered: boolean; readonly items: readonly string[] }
  | { readonly type: 'quote'; readonly text: string; readonly attribution: string | null }
  | { readonly type: 'tip'; readonly title: string | null; readonly text: string }
  | {
      readonly type: 'image';
      readonly imageId: string;
      readonly alt: string;
      readonly caption: string | null;
    }
  | { readonly type: 'product_cards'; readonly productIds: readonly string[] }
  | { readonly type: 'seller_card'; readonly sellerId: string };

export interface ApiLink {
  readonly type: string;
  readonly id: string;
}

/** The content of a version (`contentView` of the API). The event details are kept as they are. */
export interface ApiContent {
  readonly title: string;
  readonly excerpt: string;
  readonly body: readonly ApiBlock[];
  readonly coverImageId: string | null;
  readonly coverAlt: string | null;
  readonly seoTitle: string | null;
  readonly seoDescription: string | null;
  readonly authorDisplay: string | null;
  readonly categoryId: string | null;
  readonly tagIds: readonly string[];
  readonly links: readonly ApiLink[];
  readonly event: Readonly<Record<string, unknown>> | null;
}

export interface VersionView {
  readonly id: string;
  readonly versionNo: number;
  readonly state: string;
  readonly content: ApiContent;
  readonly editedByReviewer: boolean;
  readonly updatedAt: string;
  readonly decision: 'approved' | 'changes_requested' | null;
  readonly decisionNote: string | null;
}

export interface PostDetail {
  readonly id: string;
  readonly kind: PostKind;
  readonly slug: string;
  readonly ownerType: 'platform' | 'seller';
  readonly sellerId: string | null;
  readonly status: PostStatus;
  readonly featured?: boolean;
  readonly scheduledAt?: string | null;
  readonly publishedAt?: string | null;
  readonly pausedReason?: string | null;
  readonly open: VersionView | null;
  readonly live: VersionView | null;
}

export interface Taxonomy {
  readonly categories: readonly {
    readonly id: string;
    readonly slug: string;
    readonly names: Readonly<Record<string, string>>;
  }[];
  readonly tags: readonly { readonly id: string; readonly slug: string; readonly name: string }[];
}

export interface Finding {
  readonly severity: 'error' | 'warning' | 'notice';
  readonly code: string;
  readonly path: string | null;
}

export interface ChecksBody {
  readonly versionNo: number;
  readonly findings: readonly Finding[];
}
