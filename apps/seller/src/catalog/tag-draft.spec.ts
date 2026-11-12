import { describe, expect, it } from 'vitest';
import { contentFrom, topicIdsOf } from './draft-content.ts';
import { editProblemOf, topicIssuesOf } from './edit-errors.ts';

const parts = { categoryIds: [], taxCategoryCode: '', attributeValues: {}, variants: null };
const A = '0197a1b2-0000-7000-8000-000000000001';
const B = '0197a1b2-0000-7000-8000-000000000002';

describe('topicIdsOf', () => {
  it('reads the ids in the order entered and ignores anything else', () => {
    expect(topicIdsOf({ topicIds: [B, A] })).toEqual([B, A]);
    expect(topicIdsOf({ topicIds: [A, 3, null, { a: 1 }, B] })).toEqual([A, B]);
    expect(topicIdsOf({ topicIds: 'x' })).toEqual([]);
    expect(topicIdsOf({})).toEqual([]);
    expect(topicIdsOf(undefined)).toEqual([]);
  });
});

describe('contentFrom topicIds', () => {
  it('writes the ids in the order picked', () => {
    expect(contentFrom({}, { ...parts, topicIds: [B, A] })).toMatchObject({ topicIds: [B, A] });
  });

  it('drops the key when none are left, and never adds it to a draft that had none', () => {
    expect(contentFrom({ topicIds: [A] }, { ...parts, topicIds: [] })).not.toHaveProperty(
      'topicIds',
    );
    expect(contentFrom({}, { ...parts, topicIds: [] })).not.toHaveProperty('topicIds');
  });

  it('leaves the draft alone when the caller gives no ids', () => {
    expect(contentFrom({ topicIds: [A] }, parts)).toMatchObject({ topicIds: [A] });
  });
});

describe('tag refusals of the freeze', () => {
  const issues = [
    { path: 'topicIds', code: 'too-many' },
    { path: 'topicIds.0', code: 'unknown' },
    { path: 'topicIds.2', code: 'archived' },
    { path: 'topicIds.3', code: 'duplicate' },
  ];

  it.each([
    ['unknown', { index: 0, code: 'unknown' }],
    ['archived', { index: 2, code: 'archived' }],
    ['duplicate', { index: 3, code: 'duplicate' }],
    ['too-many', { index: null, code: 'too-many' }],
  ])('maps %s to its place', (_name, expected) => {
    expect(topicIssuesOf(issues)).toContainEqual(expected);
  });

  it('ignores paths and codes that are not tag problems', () => {
    expect(
      topicIssuesOf([
        { path: 'topicIds', code: 'invalid' },
        { path: 'topicIds.1', code: 'invalid' },
        { path: 'topicIds.1', code: 'too-many' },
        { path: 'topicIdsX', code: 'unknown' },
        { path: 'attributes.size', code: 'unknown' },
      ]),
    ).toEqual([]);
  });

  it('keeps tag issues out of the raw lines and every other line in', () => {
    const problem = editProblemOf({
      status: 422,
      code: 'revision.not-ready',
      details: { issues: [...issues, { path: 'attributes.size', code: 'required' }] },
    });
    expect(problem.key).toBe('catalog.edit.error.not-ready');
    expect(problem.details).toEqual(['attributes.size: required']);
    expect(problem.topicIssues).toHaveLength(4);
  });

  it('keeps a malformed tag line as a raw line', () => {
    const problem = editProblemOf({
      status: 422,
      code: 'revision.not-ready',
      details: { issues: [{ path: 'topicIds.1', code: 'invalid' }] },
    });
    expect(problem.details).toEqual(['topicIds.1: invalid']);
    expect(problem.topicIssues).toBeUndefined();
  });
});
