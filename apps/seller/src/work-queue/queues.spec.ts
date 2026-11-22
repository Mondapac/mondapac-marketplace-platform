import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { SELLER_QUEUES } from './queues.ts';

/** The name of a permission constant in the API: `ordering.seller-order.view` → ORDERING_SELLER_ORDER_VIEW. */
const constantOf = (key: string) => key.replace(/[.-]/g, '_').toUpperCase();

describe('the seller tasks against the API', () => {
  it('names every seller task the API binds, at its level, in its order and with its key', () => {
    // The panel cannot import the API (panel boundaries): read the bindings as text.
    const source = readFileSync(
      fileURLToPath(
        new URL('../../../api/src/modules/dashboard/dashboard.module.ts', import.meta.url),
      ),
      'utf8',
    );
    const bound = [
      ...source.matchAll(
        /key: '([^']+)',\s*panel: '(admin|seller)',\s*level: '([a-z]+)',\s*requires: \[([A-Z_]+)\.key\]/g,
      ),
    ]
      .filter((match) => match[2] === 'seller')
      .map((match) => `${match[1]}:${match[3]}:${match[4]}`);
    expect(bound.length).toBeGreaterThan(0);
    const levelOf = (index: number) => (index < 3 ? 'critical' : index < 6 ? 'today' : 'review');
    expect(
      SELLER_QUEUES.map(
        (queue, index) => `${queue.key}:${levelOf(index)}:${constantOf(queue.requires)}`,
      ),
    ).toEqual(bound);
  });
});
