import { describe, expect, it } from 'vitest';
import { instantToLocal, localToInstant } from '../slides/zone-time.ts';
import {
  formOf,
  mapProblems,
  requestOf,
  sameForm,
  sourceOf,
  validate,
  type SettingsForm,
} from './settings-form.ts';
import { page } from './test-data.ts';

const ZONE = 'Australia/Brisbane';
const toLocal = (instant: string) => instantToLocal(instant, ZONE);
const toInstant = (local: string) => localToInstant(local, ZONE);
const base = (): SettingsForm => formOf(page(), toLocal);

describe('where the form starts', () => {
  it('starts from the page buyers see when no settings wait in the draft', () => {
    expect(base()).toMatchObject({
      title: 'Ramadan specials',
      slug: 'ramadan',
      seoTitle: 'Ramadan',
      seoDescription: 'Offers for Ramadan',
      linkedId: '',
      startsAt: '',
    });
  });

  it('starts from the settings that wait in the draft, with times on the Market clock', () => {
    const waiting = page({
      draft: {
        ...page().draft,
        settings: {
          title: 'Eid',
          slug: 'eid',
          seo: { image: { ref: 'fruits', alt: 'Fruit' } },
          linked: { type: 'category', id: 'c1' },
          startsAt: '2026-12-01T00:00:00Z',
          endsAt: null,
        },
      },
    });
    expect(formOf(waiting, toLocal)).toMatchObject({
      title: 'Eid',
      slug: 'eid',
      linkedId: 'c1',
      startsAt: '2026-12-01T10:00',
      endsAt: '',
      image: { ref: 'fruits', alt: 'Fruit' },
    });
    expect(sourceOf(waiting).title).toBe('Eid');
  });

  it('sees a change of any field', () => {
    expect(sameForm(base(), base())).toBe(true);
    expect(sameForm(base(), { ...base(), seoTitle: 'x' })).toBe(false);
    expect(sameForm(base(), { ...base(), image: { ref: 'egg', alt: '' } })).toBe(false);
  });
});

describe('checks', () => {
  it('accepts the page as it is', () => {
    expect(validate(base(), true)).toEqual({});
  });

  it('refuses a missing title, a reserved or malformed address and a window that ends first', () => {
    expect(validate({ ...base(), title: ' ' }, true).title).toBe('required');
    expect(validate({ ...base(), slug: 'home' }, true).slug).toBe('reserved');
    expect(validate({ ...base(), slug: 'Not Valid' }, true).slug).toBe('format');
    expect(validate({ ...base(), slug: '' }, true).slug).toBe('required');
    expect(
      validate({ ...base(), startsAt: '2026-12-02T09:00', endsAt: '2026-12-01T09:00' }, true)
        .endsAt,
    ).toBe('before-start');
  });

  it('does not check an address or window a system page does not have', () => {
    expect(
      validate(
        { ...base(), slug: '', startsAt: '2026-12-02T09:00', endsAt: '2026-12-01T09:00' },
        false,
      ),
    ).toEqual({});
  });

  it('counts the SEO texts and wants a description with a picture, and a picture with a description', () => {
    expect(validate({ ...base(), seoTitle: 'x'.repeat(71) }, true).seoTitle).toBe('too-long');
    expect(validate({ ...base(), seoDescription: 'x'.repeat(161) }, true).seoDescription).toBe(
      'too-long',
    );
    expect(validate({ ...base(), image: { ref: 'egg', alt: '' } }, true).imageAlt).toBe('required');
    expect(validate({ ...base(), image: { ref: '', alt: 'An egg' } }, true).imageRef).toBe(
      'required',
    );
  });
});

describe('what the API refused', () => {
  it('marks the field each path names', () => {
    expect(
      mapProblems([
        { path: 'title', code: 'required' },
        { path: 'slug', code: 'reserved' },
        { path: 'seo.title', code: 'length' },
        { path: 'seo.description', code: 'length' },
        { path: 'seo.image.ref', code: 'format' },
        { path: 'seo.image.alt', code: 'required' },
        { path: 'linked.id', code: 'format' },
        { path: 'endsAt', code: 'before-start' },
        { path: 'startsAt', code: 'format' },
      ]).fields,
    ).toEqual({
      title: 'required',
      slug: 'reserved',
      seoTitle: 'too-long',
      seoDescription: 'too-long',
      imageRef: 'invalid',
      imageAlt: 'required',
      linkedId: 'invalid',
      endsAt: 'before-start',
      startsAt: 'invalid',
    });
  });

  it('keeps a path it does not know for the page-level message', () => {
    expect(mapProblems([{ path: 'mystery', code: 'x' }])).toEqual({
      fields: {},
      other: ['mystery:x'],
    });
  });
});

describe('the body of a save', () => {
  it('sends a live window that was not touched exactly as it was, seconds included', () => {
    const timed = page({ startsAt: '2026-12-01T00:00:30Z', endsAt: '2026-12-08T00:00:00Z' });
    const body = requestOf({ ...formOf(timed, toLocal), title: 'New' }, timed, toInstant, toLocal);
    expect(body.startsAt).toBe('2026-12-01T00:00:30Z');
    expect(body.endsAt).toBe('2026-12-08T00:00:00Z');
    const moved = requestOf(
      { ...formOf(timed, toLocal), startsAt: '2026-12-02T09:00' },
      timed,
      toInstant,
      toLocal,
    );
    expect(moved.startsAt).toBe('2026-12-01T23:00:00.000Z');
  });

  it('replaces all the settings of a landing page, with instants for the window', () => {
    const form = {
      ...base(),
      linkedId: 'c1',
      startsAt: '2026-12-01T09:00',
      endsAt: '2026-12-08T09:00',
      seoDescription: ' ',
      image: { ref: 'fruits', alt: ' Fruit ' },
    };
    expect(requestOf(form, page(), toInstant)).toEqual({
      title: 'Ramadan specials',
      slug: 'ramadan',
      seo: { title: 'Ramadan', image: { ref: 'fruits', alt: 'Fruit' } },
      linked: { type: 'category', id: 'c1' },
      startsAt: '2026-11-30T23:00:00.000Z',
      endsAt: '2026-12-07T23:00:00.000Z',
    });
  });

  it('keeps a link to a product or seller that this editor cannot change', () => {
    const linked = page({ linked: { type: 'product', id: 'p1' } });
    expect(requestOf(formOf(linked, toLocal), linked, toInstant).linked).toEqual({
      type: 'product',
      id: 'p1',
    });
  });

  it('sends a system page its title and SEO only', () => {
    const system = page({ kind: 'system', id: null, systemKey: 'home', slug: null });
    expect(requestOf(formOf(system, toLocal), system, toInstant)).toEqual({
      title: 'Ramadan specials',
      seo: { title: 'Ramadan', description: 'Offers for Ramadan' },
    });
  });
});
