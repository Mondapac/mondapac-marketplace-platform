import {
  BODY_LIMITS,
  bodyTexts,
  imagesOf,
  parseBody,
  productsOf,
  readingMinutes,
  sellersOf,
} from './body';
import type { Problems } from './fields';

const ID_A = '0197a000-0000-7000-8000-00000000000a';
const ID_B = '0197a000-0000-7000-8000-00000000000b';

const parse = (value: unknown): { blocks: ReturnType<typeof parseBody>; problems: Problems } => {
  const problems: Problems = [];
  return { blocks: parseBody(problems, 'body', value), problems };
};

describe('post body', () => {
  it('reads an absent body as an empty list', () => {
    expect(parse(undefined)).toEqual({ blocks: [], problems: [] });
  });

  it('accepts every block type and normalises the text', () => {
    const { blocks, problems } = parse([
      { type: 'paragraph', text: '  Hello  ' },
      { type: 'heading', level: 2, text: 'Why' },
      { type: 'list', ordered: false, items: ['a', 'b'] },
      { type: 'image', imageId: ID_A, alt: 'A bowl', caption: 'Dinner' },
      { type: 'quote', text: 'Nice', attribution: 'Sam' },
      { type: 'tip', title: 'Tip', text: 'Soak first' },
      { type: 'product_cards', productIds: [ID_A, ID_B] },
      { type: 'seller_card', sellerId: ID_B },
    ]);
    expect(problems).toEqual([]);
    expect(blocks).toHaveLength(8);
    expect(blocks?.[0]).toEqual({ type: 'paragraph', text: 'Hello' });
    expect(productsOf(blocks!)).toEqual([ID_A, ID_B]);
    expect(sellersOf(blocks!)).toEqual([ID_B]);
  });

  it.each([
    [
      'markup in a paragraph',
      [{ type: 'paragraph', text: '<b>bold</b>' }],
      'body[0].text',
      'markup',
    ],
    [
      'a script tag',
      [{ type: 'paragraph', text: 'x<script>alert(1)</script>' }],
      'body[0].text',
      'markup',
    ],
    ['an unknown type', [{ type: 'html', text: 'x' }], 'body[0].type', 'value'],
    ['an embed', [{ type: 'embed', url: 'https://x.test' }], 'body[0].type', 'value'],
    [
      'an unknown field',
      [{ type: 'paragraph', text: 'x', style: 'red' }],
      'body[0].style',
      'unknown-field',
    ],
    ['a heading level 1', [{ type: 'heading', level: 1, text: 'x' }], 'body[0].level', 'value'],
    ['a bad image id', [{ type: 'image', imageId: 'nope', alt: 'x' }], 'body[0].imageId', 'format'],
    [
      'duplicate cards',
      [{ type: 'product_cards', productIds: [ID_A, ID_A] }],
      'body[0].productIds',
      'duplicate',
    ],
    [
      'a hidden character',
      [{ type: 'paragraph', text: 'a‮b' }],
      'body[0].text',
      'invisible-character',
    ],
    ['a block that is not an object', ['text'], 'body[0]', 'type'],
  ])('refuses %s', (_name, value, path, code) => {
    const { blocks, problems } = parse(value);
    expect(blocks).toBeNull();
    expect(problems).toContainEqual({ path, code });
  });

  it('refuses a body that is not a list and one with too many blocks', () => {
    expect(parse({}).problems).toEqual([{ path: 'body', code: 'type' }]);
    const many = Array.from({ length: BODY_LIMITS.blocks + 1 }, () => ({
      type: 'paragraph',
      text: 'x',
    }));
    expect(parse(many).problems).toEqual([{ path: 'body', code: 'count' }]);
  });

  it('refuses a text over its limit', () => {
    const { problems } = parse([
      { type: 'paragraph', text: 'x'.repeat(BODY_LIMITS.paragraph + 1) },
    ]);
    expect(problems).toEqual([{ path: 'body[0].text', code: 'length' }]);
  });

  it('allows an empty alt in a draft and lists it for the check', () => {
    const { blocks, problems } = parse([{ type: 'image', imageId: ID_A }]);
    expect(problems).toEqual([]);
    expect(imagesOf(blocks!)).toEqual([{ path: 'body[0]', alt: '' }]);
  });

  it('lists the texts and counts reading minutes', () => {
    const { blocks } = parse([
      { type: 'paragraph', text: 'one two three' },
      { type: 'list', ordered: true, items: ['four', 'five'] },
    ]);
    expect(bodyTexts(blocks!).map((t) => t.text)).toEqual(['one two three', 'four', 'five']);
    expect(readingMinutes(blocks!)).toBe(1);
    expect(readingMinutes(blocks!, 2)).toBe(3);
  });
});
