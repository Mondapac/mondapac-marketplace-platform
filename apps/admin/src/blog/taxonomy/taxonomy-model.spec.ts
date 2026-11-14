import { describe, expect, it } from 'vitest';
import type { blankCategory } from './taxonomy-model.ts';
import { categoryBody, categoryProblem, namesOf, tagBody } from './taxonomy-model.ts';

const form = (over: Partial<ReturnType<typeof blankCategory>> = {}) => ({
  slug: 'spring-recipes',
  names: { 'en-AU': ' Spring recipes ', 'ms-MY': '  ' },
  position: '',
  ...over,
});

describe('blog taxonomy model', () => {
  it('leaves empty names out and trims the rest', () => {
    expect(namesOf(form())).toEqual({ 'en-AU': 'Spring recipes' });
  });

  it('sends the address only when creating, and the order only when given', () => {
    expect(categoryBody(form(), true)).toEqual({
      slug: 'spring-recipes',
      names: { 'en-AU': 'Spring recipes' },
    });
    expect(categoryBody(form({ position: '3' }), false)).toEqual({
      names: { 'en-AU': 'Spring recipes' },
      position: 3,
    });
  });

  it('stops a bad address, a missing main-language name and a bad order before sending', () => {
    expect(categoryProblem(form(), 'en-AU', true)).toBeNull();
    expect(categoryProblem(form({ slug: 'Bad Slug' }), 'en-AU', true)).toBe('slug');
    expect(categoryProblem(form({ slug: 'a' }), 'en-AU', true)).toBe('slug');
    expect(categoryProblem(form({ slug: 'Bad Slug' }), 'en-AU', false)).toBeNull();
    expect(categoryProblem(form({ names: { 'ms-MY': 'Resipi' } }), 'en-AU', true)).toBe('name');
    expect(categoryProblem(form({ position: '-1' }), 'en-AU', true)).toBe('position');
    expect(categoryProblem(form({ position: '1.5' }), 'en-AU', true)).toBe('position');
  });

  it('makes a tag body with or without an address', () => {
    expect(tagBody(' Eid ', '')).toEqual({ name: 'Eid' });
    expect(tagBody('Eid', ' eid-2026 ')).toEqual({ name: 'Eid', slug: 'eid-2026' });
  });
});
