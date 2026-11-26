import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { ASSISTANT_AI_CAPABILITIES } from '../../src/modules/assistant/contracts/ai-capabilities';
import { CATALOG_AI_CAPABILITIES } from '../../src/modules/catalog/contracts/ai-capabilities';
import {
  AI_BUYER_CHAT_CAPABILITY,
  AI_CAPABILITY_SWITCHES,
  AI_MODEL_TASKS,
  familiesOf,
} from '../../src/modules/settings/domain/definitions';
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

  // settings names the buyer chat by a string of its own (it imports no module), so the id must be
  // the capability assistant registers: a renamed capability would silently lose its caps (G4d2).
  it('caps a capability id that assistant registers (the buyer chat)', () => {
    expect(ASSISTANT_AI_CAPABILITIES.map((spec) => spec.id)).toContain(AI_BUYER_CHAT_CAPABILITY);
  });

  // settings names each capability's switch by strings of its own (G4d3): every capability a
  // module registers has exactly one switch, and every switch names a registered capability. A
  // capability without a switch is off at the gateway, so a missing entry fails closed, but a new
  // capability must reach the AI Gateway page (and a renamed one must not lose its switch).
  it('has one capability switch per registered capability, and none other (G4d3)', () => {
    const registered = [...ASSISTANT_AI_CAPABILITIES, ...CATALOG_AI_CAPABILITIES].map(
      (spec) => spec.id,
    );
    expect(Object.values(AI_CAPABILITY_SWITCHES).sort()).toEqual([...registered].sort());
    for (const code of Object.keys(AI_CAPABILITY_SWITCHES)) {
      expect(code).toMatch(/^ai-capability-[a-z0-9-]+$/);
      expect(code.length).toBeLessThanOrEqual(64);
    }
  });

  it('knows every module that registers capabilities (assistant and catalog)', () => {
    const root = path.resolve(__dirname, '../../src/modules');
    const registering: string[] = [];
    const walk = (dir: string): void => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) walk(full);
        else if (
          entry.name.endsWith('.ts') &&
          !entry.name.endsWith('.spec.ts') &&
          readFileSync(full, 'utf8').includes('registerCapabilities(')
        ) {
          registering.push(path.relative(root, full).split(path.sep)[0]!);
        }
      }
    };
    walk(root);
    expect([...new Set(registering)].sort()).toEqual(['assistant', 'catalog']);
  });
});
