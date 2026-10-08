import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';

// Ali's condition on the test-only panel-origin overlay (PR #179): the overlay that fills AU's
// empty admin and seller lists lives in test/support only, and no file under src/ (spec files
// included) imports it. The refusal tests against the checked-in configuration stay.

const SRC = path.resolve(__dirname, '../src');

function filesUnder(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(directory, entry.name);
    return entry.isDirectory() ? filesUnder(full) : [full];
  });
}

describe('the test-only panel-origin overlay', () => {
  it('is not used by any file under src/', () => {
    const users = filesUnder(SRC)
      .filter((file) => file.endsWith('.ts'))
      .filter((file) =>
        /panelOriginMarketConfigDirs|panelOrigins\s*:/.test(readFileSync(file, 'utf8')),
      )
      .map((file) => path.relative(SRC, file));

    expect(users).toEqual([]);
  });

  it('keeps the refusal tests against the checked-in configuration', () => {
    const guardSpec = readFileSync(
      path.join(SRC, 'platform/call-context/call-context.spec.ts'),
      'utf8',
    );
    const e2e = readFileSync(path.join(__dirname, 'route-population.e2e.spec.ts'), 'utf8');

    expect(guardSpec).toContain(
      'is refused with the checked-in configuration while its list is empty',
    );
    expect(e2e).toContain('applies the checked-in list');
  });
});
