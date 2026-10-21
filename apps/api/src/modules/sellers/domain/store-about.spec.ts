import { parseAboutText, STORE_ABOUT_MAX_LENGTH } from './store-about';

describe('parseAboutText', () => {
  it('trims, keeps paragraphs, turns CRLF into line feeds and normalises to NFC', () => {
    expect(parseAboutText('  First\r\n\r\nSecond\rThird  ')).toEqual({
      ok: true,
      value: 'First\n\nSecond\nThird',
    });
    expect(parseAboutText('Café')).toEqual({ ok: true, value: 'Café' });
  });

  it('accepts an empty text (it clears a locale) and Arabic text with a joining ZWNJ', () => {
    expect(parseAboutText('   ')).toEqual({ ok: true, value: '' });
    expect(parseAboutText('می‌خواهم')).toMatchObject({ ok: true });
  });

  it('keeps ordinary prose with full stops', () => {
    for (const text of [
      'We bake daily. Open 7am.',
      'Fresh bread, e.g. sourdough. Closed Sundays.',
      'Since 1998... still family run.',
      'Halal meat and more. Call us in store.',
    ]) {
      expect(parseAboutText(text)).toMatchObject({ ok: true });
    }
  });

  it('counts characters, not UTF-16 units', () => {
    expect(parseAboutText('😀'.repeat(STORE_ABOUT_MAX_LENGTH))).toMatchObject({ ok: true });
    expect(parseAboutText('😀'.repeat(STORE_ABOUT_MAX_LENGTH + 1))).toEqual({
      ok: false,
      error: { code: 'about.invalid', rule: 'length' },
    });
  });

  it.each([
    ['https://example.com', 'url'],
    ['see www.example', 'url'],
    ['mail us at shop.example.com', 'url'],
    ['order at example.com/shop', 'url'],
    ['Visit myshop.com.', 'url'],
    ['myshop.com, now', 'url'],
    ['t.me/mystore', 'url'],
    ['bob@shop.io!', 'url'],
    ['myshop。com', 'url'],
    ['myshop．com', 'url'],
    ['myshop｡com', 'url'],
    ['ｍｙｓｈｏｐ.ｃｏｍ', 'url'],
    ['bob＠shop.io', 'url'],
    ['bell\u0007', 'characters'],
    ['tab\there is fine?', 'characters'],
    ['‮evil', 'characters'],
    ['zero​width', 'characters'],
    ['lone ‍ joiner', 'characters'],
  ])('refuses %j as %s', (text, rule) => {
    expect(parseAboutText(text)).toEqual({ ok: false, error: { code: 'about.invalid', rule } });
  });

  it('refuses a value that is not a string', () => {
    expect(parseAboutText(5)).toEqual({
      ok: false,
      error: { code: 'about.invalid', rule: 'characters' },
    });
  });
});
