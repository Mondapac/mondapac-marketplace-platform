import { describe, expect, it } from 'vitest';
import {
  EMPTY_FORM,
  RESERVED_SLUGS,
  mapProblems,
  requestOf,
  slugOf,
  validate,
} from './page-form.ts';

const ok = { ...EMPTY_FORM, template: 'info-page' as const, title: 'Eid hours', slug: 'eid-hours' };

describe('slugOf', () => {
  it('makes lower-case hyphenated words from a title', () => {
    expect(slugOf('Ramadan Specials 2026!')).toBe('ramadan-specials-2026');
    expect(slugOf('  Café  & Bakery ')).toBe('cafe-bakery');
  });

  it('stops at 80 characters without a trailing hyphen', () => {
    const slug = slugOf(`${'a'.repeat(79)} b`);
    expect(slug.length).toBeLessThanOrEqual(80);
    expect(slug.endsWith('-')).toBe(false);
  });

  it('is empty for a title with no letters or digits', () => {
    expect(slugOf('!!!')).toBe('');
  });
});

describe('validate', () => {
  it('accepts a complete form', () => {
    expect(validate(ok)).toEqual({});
  });

  it('asks for a template, a title and an address', () => {
    expect(validate(EMPTY_FORM)).toEqual({
      template: 'required',
      title: 'required',
      slug: 'required',
    });
  });

  it('refuses a title over 120 characters', () => {
    expect(validate({ ...ok, title: 'x'.repeat(121) }).title).toBe('too-long');
  });

  it('refuses a badly formed slug, and reserved words', () => {
    expect(validate({ ...ok, slug: 'Eid Hours' }).slug).toBe('format');
    expect(validate({ ...ok, slug: 'a--b' }).slug).toBe('format');
    expect(validate({ ...ok, slug: 'a'.repeat(81) }).slug).toBe('format');
    for (const word of ['cart', 'home', 'navigation', 'l', 'new']) {
      expect(RESERVED_SLUGS.has(word)).toBe(true);
      expect(validate({ ...ok, slug: word }).slug).toBe('reserved');
    }
  });

  it('wants the end after the start', () => {
    expect(
      validate({ ...ok, startsAt: '2026-12-02T09:00', endsAt: '2026-12-01T09:00' }).endsAt,
    ).toBe('before-start');
    expect(validate({ ...ok, startsAt: '2026-12-01T09:00', endsAt: '2026-12-02T09:00' })).toEqual(
      {},
    );
  });
});

describe('mapProblems', () => {
  it('puts the API field problems on the form fields', () => {
    expect(
      mapProblems([
        { path: 'slug', code: 'reserved' },
        { path: 'title', code: 'required' },
        { path: 'linked.id', code: 'format' },
        { path: 'endsAt', code: 'before-start' },
        { path: 'seo.title', code: 'too-long' },
      ]),
    ).toEqual({
      fields: {
        slug: 'reserved',
        title: 'required',
        linkedId: 'invalid',
        endsAt: 'before-start',
      },
      other: ['seo.title:too-long'],
    });
  });
});

describe('requestOf', () => {
  it('sends the template, the trimmed title, the slug and no link or window by default', () => {
    expect(requestOf({ ...ok, title: '  Eid hours ' }, () => null)).toEqual({
      templateKey: 'info-page',
      title: 'Eid hours',
      slug: 'eid-hours',
      linked: null,
      startsAt: null,
      endsAt: null,
    });
  });

  it('links a category and sends the window as instants', () => {
    const body = requestOf(
      { ...ok, linkedId: 'c1', startsAt: '2026-12-01T09:00', endsAt: '2026-12-02T09:00' },
      (local) => `${local}:00Z`,
    );
    expect(body).toMatchObject({
      linked: { type: 'category', id: 'c1' },
      startsAt: '2026-12-01T09:00:00Z',
      endsAt: '2026-12-02T09:00:00Z',
    });
  });
});
