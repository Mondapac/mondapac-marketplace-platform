// @vitest-environment jsdom
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import {
  CertificationSeal,
  SEAL_ARTWORK_KEYS,
  sealArt,
} from '../src/certification/certification-seal.tsx';

afterEach(cleanup);

/** The artwork keys a certification type's registry entry may name (checked-in configuration). */
const CONFIG_KEYS = (
  JSON.parse(
    // Tests run in apps/web (jsdom gives `import.meta.url` no file scheme).
    readFileSync(
      resolve(process.cwd(), '../../config/certification-badge-artwork/keys.json'),
      'utf8',
    ),
  ) as { keys: string[] }
).keys;

describe('certification seal: one seal per certificate type (the standard)', () => {
  it('draws every artwork key the registry may name, `text` being the plain badge', () => {
    expect([...SEAL_ARTWORK_KEYS, 'text'].sort()).toEqual([...CONFIG_KEYS].sort());
  });

  it.each(SEAL_ARTWORK_KEYS)('draws the %s seal as an image named by the badge label', (key) => {
    render(
      <CertificationSeal badge={{ type: 'some-type', label: `${key} label`, artwork: key }} />,
    );
    const seal = screen.getByRole('img', { name: `${key} label` });
    expect(seal.querySelector('svg')).not.toBeNull();
  });

  it('draws the seal by the artwork key, not the type code', () => {
    render(<CertificationSeal badge={{ type: 'halal', label: 'Vegan', artwork: 'vegan' }} />);
    expect(screen.getByRole('img', { name: 'Vegan' }).textContent).toContain('VEGAN');
  });

  it('falls back to the type code without a key (sample data), and to a text badge after', () => {
    const { container } = render(
      <>
        <CertificationSeal badge={{ type: 'halal', label: 'Halal certified' }} />
        <CertificationSeal badge={{ type: 'fair-trade', label: 'Fair trade' }} />
        <CertificationSeal badge={{ type: 'halal', label: 'Plain', artwork: 'text' }} />
      </>,
    );
    expect(screen.getByRole('img', { name: 'Halal certified' })).toBeDefined();
    expect([...container.querySelectorAll('.badge')].map((b) => b.textContent)).toEqual([
      'Fair trade',
      'Plain',
    ]);
  });

  it('draws nothing for a key that is an object property name', () => {
    expect(sealArt('constructor')).toBeNull();
    expect(sealArt('__proto__')).toBeNull();
  });
});
