import { describe, expect, it } from 'vitest';
import {
  EMPTY_FORM,
  carriedOf,
  contentOf,
  defaultCarried,
  formOf,
  mapProblems,
  requestOf,
  validate,
  type SlideFormState,
} from './slide-form.ts';
import type { SlideDetail } from './slide-types.ts';

const ID = '0190a000-0000-7000-8000-0000000000a1';
const filled: SlideFormState = {
  ...EMPTY_FORM,
  internalName: 'Diwali sweets week',
  title: 'Diwali sweets, delivered',
  body: 'Barfi and ladoo from local shops.',
  ctaLabel: 'Shop sweets',
  linkType: 'category',
  linkId: ID,
  imageRef: 'bread',
  alt: 'A tray of sweets',
};

describe('slide form checks', () => {
  it('accepts a complete form', () => {
    expect(validate(filled)).toEqual({});
  });

  it('asks for a name and a headline', () => {
    expect(validate(EMPTY_FORM)).toEqual({ internalName: 'required', title: 'required' });
  });

  it('counts characters the way the API does: trimmed code points', () => {
    const emoji = '🍬'.repeat(60);
    expect(validate({ ...filled, title: ` ${emoji} ` }).title).toBeUndefined();
    expect(validate({ ...filled, title: `${emoji}x` }).title).toBe('length');
    expect(validate({ ...filled, body: 'x'.repeat(161) }).body).toBe('length');
    expect(validate({ ...filled, ctaLabel: 'x'.repeat(25) }).ctaLabel).toBe('length');
    expect(validate({ ...filled, internalName: 'x'.repeat(81) }).internalName).toBe('length');
  });

  it('refuses markup characters', () => {
    expect(validate({ ...filled, title: 'Sale <b>now</b>' }).title).toBe('markup');
  });

  it('needs a description for an image unless it was saved as decorative', () => {
    expect(validate({ ...filled, alt: '  ' }).alt).toBe('required');
    expect(validate({ ...filled, alt: '', decorative: true }).alt).toBeUndefined();
    expect(validate({ ...EMPTY_FORM, internalName: 'a', title: 'b' }).alt).toBeUndefined();
  });

  it('needs something to open for a button and for the Link type', () => {
    expect(validate({ ...filled, linkType: '', linkId: '' }).ctaLabel).toBe('needs-link');
    expect(validate({ ...filled, kind: 'link', ctaLabel: '', linkType: '', linkId: '' })).toEqual({
      linkType: 'required',
    });
  });

  it('checks the id of a target by its kind: a uuid, or a code for a saved search', () => {
    expect(validate({ ...filled, linkId: 'sweets' }).linkId).toBe('format');
    expect(validate({ ...filled, linkId: ' ' }).linkId).toBe('required');
    expect(
      validate({ ...filled, linkType: 'search', linkId: 'halal-meat' }).linkId,
    ).toBeUndefined();
    expect(validate({ ...filled, linkType: 'search', linkId: 'Halal Meat' }).linkId).toBe('format');
  });
});

describe('server problems', () => {
  it('maps API paths onto fields and keeps the rest apart', () => {
    const mapped = mapProblems([
      { path: 'content.title', code: 'length' },
      { path: 'content.title', code: 'markup' },
      { path: 'content.image.alt', code: 'required' },
      { path: 'content.link.id', code: 'format' },
      { path: 'content.ctaLabel', code: 'needs-link' },
      { path: 'content.body', code: 'url' },
      { path: 'endsAt', code: 'too-long' },
      { path: 'placements[0].position', code: 'enum' },
    ]);
    expect(mapped.fields).toEqual({
      title: 'length',
      alt: 'required',
      linkId: 'format',
      ctaLabel: 'needs-link',
      body: 'url',
    });
    expect(mapped.other.map((entry) => entry.path)).toEqual(['endsAt', 'placements[0].position']);
  });

  it('reads a code it does not know as invalid', () => {
    expect(mapProblems([{ path: 'internalName', code: 'something-new' }]).fields).toEqual({
      internalName: 'invalid',
    });
  });
});

describe('the request', () => {
  const now = new Date('2026-10-25T01:00:00.000Z');

  it('creates with the kind, a 30-day window and the default position', () => {
    const body = requestOf(filled, defaultCarried(now), true);
    expect(body.kind).toBe('promotion');
    expect(body.startsAt).toBe('2026-10-25T01:00:00.000Z');
    expect(body.endsAt).toBe('2026-11-24T01:00:00.000Z');
    expect(body.placements).toEqual([
      {
        position: 'home.hero',
        scope: 'all',
        scopeId: null,
        includeSubcategories: false,
        sortOrder: 0,
        autoplay: false,
      },
    ]);
    expect(body.sponsored).toBe(false);
    expect(body.content).toEqual({
      title: 'Diwali sweets, delivered',
      body: 'Barfi and ladoo from local shops.',
      ctaLabel: 'Shop sweets',
      image: { ref: 'bread', alt: 'A tray of sweets', decorative: false },
      textPosition: 'start',
      textTone: 'light',
      link: { type: 'category', id: ID },
    });
  });

  it('leaves out what is empty, and never sends the kind on an update', () => {
    const body = requestOf(
      { ...EMPTY_FORM, internalName: ' Name ', title: ' Head ' },
      defaultCarried(now),
      false,
    );
    expect('kind' in body).toBe(false);
    expect(body.internalName).toBe('Name');
    expect(body.content).toEqual({ title: 'Head', textPosition: 'start', textTone: 'light' });
  });

  it('sends a decorative image again as decorative while no description is typed', () => {
    const content = contentOf({ ...filled, alt: '', decorative: true }, defaultCarried(now));
    expect(content.image).toEqual({ ref: 'bread', alt: '', decorative: true });
  });

  it('sends the saved window, pin, positions and text layout again on an update', () => {
    const version = {
      id: 'v',
      versionNo: 3,
      internalName: 'Saved',
      content: {
        title: 'Saved title',
        textPosition: 'end' as const,
        textTone: 'dark' as const,
      },
      placements: [
        {
          position: 'category.top',
          scope: 'category' as const,
          scopeId: ID,
          includeSubcategories: true,
          sortOrder: 2,
          autoplay: false,
        },
      ],
      startsAt: '2026-10-27T00:00:00Z',
      endsAt: '2026-11-03T13:59:00Z',
      pinned: true,
      sponsored: true,
      createdAt: '2026-10-24T00:00:00Z',
      approvedAt: null,
    };
    const slide: SlideDetail = {
      id: ID,
      kind: 'promotion',
      internalName: 'Saved',
      status: 'draft',
      startsAt: version.startsAt,
      endsAt: version.endsAt,
      pinned: true,
      sponsored: true,
      hasDraft: true,
      positions: ['category.top'],
      updatedAt: '2026-10-24T00:00:00Z',
      draft: version,
      live: null,
      pending: false,
      versions: [],
    };
    const carried = carriedOf(slide);
    const body = requestOf({ ...formOf(slide), title: 'New title' }, carried!, false);
    expect(body).toMatchObject({
      startsAt: '2026-10-27T00:00:00Z',
      endsAt: '2026-11-03T13:59:00Z',
      pinned: true,
      sponsored: true,
      placements: version.placements,
      content: { title: 'New title', textPosition: 'end', textTone: 'dark' },
    });
  });
});
