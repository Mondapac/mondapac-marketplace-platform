import { AI_MODEL_TASKS, familiesOf } from '../../src/modules/settings/domain/definitions';
import { CAPABILITY_TASKS } from '../../src/platform/ai/capability';
import { checkedInCatalogue } from '../../src/platform/ai/catalogue';

// settings keeps one priority list and one saver model per task type of platform/ai, and a list
// value holds the catalogue's families (AI Gateway G4b; Mohammad, G4b review 1 and 2).
describe('AI model settings and the platform/ai catalogue (G4b)', () => {
  it('has a setting for every task type of platform/ai, and none other', () => {
    expect([...AI_MODEL_TASKS]).toEqual([...CAPABILITY_TASKS]);
  });

  it('can hold every checked-in family, and three of the longest a family may be in one list', () => {
    const families = checkedInCatalogue().families();
    expect(families.length).toBeGreaterThan(0);
    for (const family of families) expect(familiesOf(family)).toEqual([family]);
    // The catalogue's longest family (20 characters) three times over still fits a value.
    const three = ['a'.repeat(20), 'b'.repeat(20), 'c'.repeat(20)];
    expect(familiesOf(three.join(','))).toEqual(three);
  });
});
