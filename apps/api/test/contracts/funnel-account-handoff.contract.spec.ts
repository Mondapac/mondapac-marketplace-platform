import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';

// The shopping funnel's account hand-off (dashboards v2, phase 2; Hassan I1 of PR 1328): ordering's
// `checkoutsStarted` answers account ids, and engagement's `shoppingFunnel` takes them. Only
// reporting's `FacadeEngagementSources` may call either facade method, so the ids pass from one
// facade to the other inside one call and reach no other code. `checkoutsStarted` is also the name
// of ordering's own reader port, called by its one use case. These checks read the sources, so a
// new caller fails here and the review sees it.

const SRC = path.resolve(__dirname, '../../src');

function sources(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) return sources(full);
    return entry.name.endsWith('.ts') && !entry.name.endsWith('.spec.ts') ? [full] : [];
  });
}

/** Files that call `.<method>(`, relative to `src`. */
function callersOf(method: string): string[] {
  const call = new RegExp(`\\.${method}\\s*\\(`);
  return sources(SRC)
    .filter((file) => call.test(readFileSync(file, 'utf8')))
    .map((file) => path.relative(SRC, file).split(path.sep).join('/'))
    .sort();
}

const ADAPTER = 'modules/reporting/infrastructure/facade-engagement-sources.ts';

describe('the funnel account hand-off has one caller', () => {
  it('calls engagement.shoppingFunnel only from the reporting adapter', () => {
    expect(callersOf('shoppingFunnel')).toEqual([ADAPTER]);
  });

  it('calls checkoutsStarted only from the reporting adapter and ordering’s own use case', () => {
    expect(callersOf('checkoutsStarted')).toEqual(
      [ADAPTER, 'modules/ordering/application/use-cases/checkouts-started.use-case.ts'].sort(),
    );
  });
});
