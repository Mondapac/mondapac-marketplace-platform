import { canonicalStoreContent, contentOf, parseStoreContent } from './store-profile-content';

describe('store profile content', () => {
  it('leaves blank locales out and sorts the rest, so equal content is equal bytes', () => {
    const a = canonicalStoreContent(
      contentOf({ 'en-US': 'Hi', 'ja-JP': 'こんにちは', 'xx-XX': '' }),
    );
    const b = canonicalStoreContent(contentOf({ 'ja-JP': 'こんにちは', 'en-US': 'Hi' }));

    expect(a).toEqual(b);
    expect(a).toEqual({
      ok: true,
      value: '{"about":{"en-US":"Hi","ja-JP":"こんにちは"},"schemaVersion":1}',
    });
  });

  it('reads back what it wrote', () => {
    const content = contentOf({ 'en-AU': 'Fresh bread' });
    const json = canonicalStoreContent(content);

    expect(json.ok && parseStoreContent(json.value)).toEqual({ ok: true, value: content });
  });

  it.each([
    ['not JSON', 'nope'],
    ['an array', '[]'],
    ['another schema version', '{"about":{},"schemaVersion":2}'],
    ['an extra key', '{"about":{},"schemaVersion":1,"meta":{}}'],
    ['a bad locale key', '{"about":{"english":"x"},"schemaVersion":1}'],
    ['an empty text', '{"about":{"en-AU":""},"schemaVersion":1}'],
    ['a text that is not a string', '{"about":{"en-AU":4},"schemaVersion":1}'],
  ])('refuses %s', (_, json) => {
    expect(parseStoreContent(json)).toEqual({
      ok: false,
      error: { code: 'store-profile-content.invalid' },
    });
  });
});
