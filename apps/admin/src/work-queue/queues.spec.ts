import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { ADMIN_QUEUES } from './queues.ts';

describe('the admin queues against the API', () => {
  it('names every admin queue the API binds, at its level and in its order', () => {
    // The panel cannot import the API (panel boundaries): read the bindings as text.
    const source = readFileSync(
      fileURLToPath(
        new URL('../../../api/src/modules/dashboard/dashboard.module.ts', import.meta.url),
      ),
      'utf8',
    );
    const bound = [
      ...source.matchAll(/key: '([^']+)',\s*panel: '(admin|seller)',\s*level: '([a-z]+)'/g),
    ]
      .filter((match) => match[2] === 'admin')
      .map((match) => `${match[1]}:${match[3]}`);
    expect(bound.length).toBeGreaterThan(0);
    const levelOf = (index: number) => (index < 4 ? 'critical' : index < 15 ? 'today' : 'review');
    expect(ADMIN_QUEUES.map((queue, index) => `${queue.key}:${levelOf(index)}`)).toEqual(bound);
  });
});
