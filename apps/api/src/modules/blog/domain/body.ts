import { at, closedObject, isRecord, isUuid, plainText, problem, uuid } from './fields';
import type { Problems } from './fields';

// The body of a post: a closed list of blocks, stored as JSON and rendered on the server. There is
// no HTML, no embed and no video: every text of a block is plain text without angle brackets, an
// image is an id and its alt text, a product or seller card is an id (price and stock are read live
// from the catalog when the card is shown, never typed). A block with a field outside its shape, or
// of a type outside the list, is refused whole, so nothing unknown is ever stored.

export const BLOCK_TYPES = [
  'paragraph',
  'heading',
  'list',
  'image',
  'quote',
  'tip',
  'product_cards',
  'seller_card',
] as const;
export type BlockType = (typeof BLOCK_TYPES)[number];

/** The caps of the editor, also what the checks and the tests name. */
export const BODY_LIMITS = Object.freeze({
  blocks: 200,
  paragraph: 2000,
  heading: 120,
  listItems: 20,
  listItem: 300,
  quote: 600,
  quoteBy: 120,
  tip: 600,
  tipTitle: 60,
  alt: 200,
  caption: 200,
  productCards: 12,
});

export type Block =
  | { readonly type: 'paragraph'; readonly text: string }
  | { readonly type: 'heading'; readonly level: 2 | 3; readonly text: string }
  | { readonly type: 'list'; readonly ordered: boolean; readonly items: readonly string[] }
  | {
      readonly type: 'image';
      readonly imageId: string;
      /** May be empty in a draft: the automatic check refuses a submit without it. */
      readonly alt: string;
      readonly caption: string | null;
    }
  | { readonly type: 'quote'; readonly text: string; readonly attribution: string | null }
  | { readonly type: 'tip'; readonly title: string | null; readonly text: string }
  | { readonly type: 'product_cards'; readonly productIds: readonly string[] }
  | { readonly type: 'seller_card'; readonly sellerId: string };

function altText(problems: Problems, path: string, value: unknown): string {
  // An empty alt is a draft in progress, not an invalid block: the submit check names it.
  if (value === undefined || value === null || (typeof value === 'string' && value.trim() === '')) {
    return '';
  }
  return plainText(problems, path, value, { max: BODY_LIMITS.alt }) ?? '';
}

function parseBlock(problems: Problems, path: string, value: unknown): Block | null {
  if (!isRecord(value)) {
    problem(problems, path, 'type');
    return null;
  }
  const type = value.type;
  switch (type) {
    case 'paragraph': {
      if (!closedObject(problems, path, value, ['type', 'text'])) return null;
      const text = plainText(problems, at(path, 'text'), value.text, {
        max: BODY_LIMITS.paragraph,
      });
      return text === null ? null : { type, text };
    }
    case 'heading': {
      if (!closedObject(problems, path, value, ['type', 'level', 'text'])) return null;
      const text = plainText(problems, at(path, 'text'), value.text, { max: BODY_LIMITS.heading });
      if (value.level !== 2 && value.level !== 3) {
        problem(problems, at(path, 'level'), value.level === undefined ? 'required' : 'value');
        return null;
      }
      return text === null ? null : { type, level: value.level, text };
    }
    case 'list': {
      if (!closedObject(problems, path, value, ['type', 'ordered', 'items'])) return null;
      if (typeof value.ordered !== 'boolean') {
        problem(problems, at(path, 'ordered'), value.ordered === undefined ? 'required' : 'type');
        return null;
      }
      if (!Array.isArray(value.items)) {
        problem(problems, at(path, 'items'), value.items === undefined ? 'required' : 'type');
        return null;
      }
      if (value.items.length < 1 || value.items.length > BODY_LIMITS.listItems) {
        problem(problems, at(path, 'items'), 'count');
        return null;
      }
      const items: string[] = [];
      for (const [index, item] of (value.items as unknown[]).entries()) {
        const text = plainText(problems, at(at(path, 'items'), index), item, {
          max: BODY_LIMITS.listItem,
        });
        if (text !== null) items.push(text);
      }
      return items.length === value.items.length ? { type, ordered: value.ordered, items } : null;
    }
    case 'image': {
      if (!closedObject(problems, path, value, ['type', 'imageId', 'alt', 'caption'])) return null;
      const imageId = uuid(problems, at(path, 'imageId'), value.imageId);
      const alt = altText(problems, at(path, 'alt'), value.alt);
      const caption = plainText(problems, at(path, 'caption'), value.caption, {
        max: BODY_LIMITS.caption,
        optional: true,
      });
      return imageId === null ? null : { type, imageId, alt, caption };
    }
    case 'quote': {
      if (!closedObject(problems, path, value, ['type', 'text', 'attribution'])) return null;
      const text = plainText(problems, at(path, 'text'), value.text, { max: BODY_LIMITS.quote });
      const attribution = plainText(problems, at(path, 'attribution'), value.attribution, {
        max: BODY_LIMITS.quoteBy,
        optional: true,
      });
      return text === null ? null : { type, text, attribution };
    }
    case 'tip': {
      if (!closedObject(problems, path, value, ['type', 'title', 'text'])) return null;
      const title = plainText(problems, at(path, 'title'), value.title, {
        max: BODY_LIMITS.tipTitle,
        optional: true,
      });
      const text = plainText(problems, at(path, 'text'), value.text, { max: BODY_LIMITS.tip });
      return text === null ? null : { type, title, text };
    }
    case 'product_cards': {
      if (!closedObject(problems, path, value, ['type', 'productIds'])) return null;
      const ids = value.productIds;
      if (!Array.isArray(ids)) {
        problem(problems, at(path, 'productIds'), ids === undefined ? 'required' : 'type');
        return null;
      }
      if (ids.length < 1 || ids.length > BODY_LIMITS.productCards) {
        problem(problems, at(path, 'productIds'), 'count');
        return null;
      }
      const productIds: string[] = [];
      for (const [index, id] of (ids as unknown[]).entries()) {
        const parsed = uuid(problems, at(at(path, 'productIds'), index), id);
        if (parsed !== null) productIds.push(parsed);
      }
      if (productIds.length !== ids.length) return null;
      if (new Set(productIds).size !== productIds.length) {
        problem(problems, at(path, 'productIds'), 'duplicate');
        return null;
      }
      return { type, productIds };
    }
    case 'seller_card': {
      if (!closedObject(problems, path, value, ['type', 'sellerId'])) return null;
      const sellerId = uuid(problems, at(path, 'sellerId'), value.sellerId);
      return sellerId === null ? null : { type, sellerId };
    }
    default:
      problem(problems, at(path, 'type'), type === undefined ? 'required' : 'value');
      return null;
  }
}

/**
 * Validates a body and returns the normalised blocks, or null with problems. An absent body is an
 * empty list (a draft just created). Never throws.
 */
export function parseBody(
  problems: Problems,
  path: string,
  value: unknown,
): readonly Block[] | null {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value)) {
    problem(problems, path, 'type');
    return null;
  }
  if (value.length > BODY_LIMITS.blocks) {
    problem(problems, path, 'count');
    return null;
  }
  const blocks: Block[] = [];
  const before = problems.length;
  for (const [index, entry] of (value as unknown[]).entries()) {
    const block = parseBlock(problems, at(path, index), entry);
    if (block !== null) blocks.push(block);
  }
  return problems.length === before ? blocks : null;
}

/** Whether a stored value is a body this module wrote (used when reading a stored version). */
export function readBody(value: unknown): readonly Block[] {
  const problems: Problems = [];
  return parseBody(problems, 'body', value) ?? [];
}

/** Every product a card block names, once each, in the order of the body. */
export function productsOf(body: readonly Block[]): readonly string[] {
  const seen = new Set<string>();
  for (const block of body) {
    if (block.type === 'product_cards') for (const id of block.productIds) seen.add(id);
  }
  return [...seen];
}

/** Every seller a card block names, once each, in the order of the body. */
export function sellersOf(body: readonly Block[]): readonly string[] {
  const seen = new Set<string>();
  for (const block of body) if (block.type === 'seller_card') seen.add(block.sellerId);
  return [...seen];
}

/** One text of a body with the path of its block, for the checks that read free text. */
export interface BodyText {
  readonly path: string;
  readonly text: string;
}

export function bodyTexts(body: readonly Block[]): readonly BodyText[] {
  const texts: BodyText[] = [];
  for (const [index, block] of body.entries()) {
    const path = `body[${index}]`;
    switch (block.type) {
      case 'paragraph':
      case 'heading':
        texts.push({ path, text: block.text });
        break;
      case 'list':
        for (const item of block.items) texts.push({ path, text: item });
        break;
      case 'image':
        if (block.alt !== '') texts.push({ path, text: block.alt });
        if (block.caption !== null) texts.push({ path, text: block.caption });
        break;
      case 'quote':
        texts.push({ path, text: block.text });
        if (block.attribution !== null) texts.push({ path, text: block.attribution });
        break;
      case 'tip':
        if (block.title !== null) texts.push({ path, text: block.title });
        texts.push({ path, text: block.text });
        break;
      default:
        break;
    }
  }
  return texts;
}

/** The images of a body with their block path, for the alt text check. */
export function imagesOf(
  body: readonly Block[],
): readonly { readonly path: string; readonly alt: string }[] {
  const images: { path: string; alt: string }[] = [];
  for (const [index, block] of body.entries()) {
    if (block.type === 'image') images.push({ path: `body[${index}]`, alt: block.alt.trim() });
  }
  return images;
}

/** Whole minutes to read the body, at least one; the words of every text block over `wpm`. */
export function readingMinutes(body: readonly Block[], wordsPerMinute = 200): number {
  let words = 0;
  for (const { text } of bodyTexts(body)) {
    words += text.split(/\s+/u).filter((word) => word !== '').length;
  }
  return Math.max(1, Math.ceil(words / wordsPerMinute));
}

export { isUuid };
