// Built-kernel check (platform-foundations design 3.7 and its section 13 note): after
// `pnpm build`, the API must load ONE build of the shared kernel through both of its
// entries, `@mondapac/shared-kernel` and `@mondapac/shared-kernel/testing`. Minted
// contexts are recorded in a module-private WeakSet, so a second copy of the kernel in
// one process would make every context from the other copy fail `isMinted`.
//
// This part checks resolution from the API package and that a context minted through the
// `/testing` builders passes `isMinted` from the main entry. Slice 0 item 3b adds the check
// through the built API's own `platform/` code; item 4 adds the deep-import assertions.
//
// Usage: node scripts/check-built-kernel.mjs   (run by `pnpm build`)
import { realpathSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const fromApi = createRequire(path.join(root, 'apps/api/package.json'));
const problems = [];

let kernelDist;
try {
  kernelDist = realpathSync(path.join(root, 'packages/shared-kernel/dist')) + path.sep;
} catch {
  console.error(
    'Built-kernel check failed: packages/shared-kernel/dist is missing (run pnpm build).',
  );
  process.exit(1);
}

const entries = ['@mondapac/shared-kernel', '@mondapac/shared-kernel/testing'];
const resolved = new Map();
for (const entry of entries) {
  try {
    const file = realpathSync(fromApi.resolve(entry));
    resolved.set(entry, file);
    if (!file.startsWith(kernelDist)) {
      problems.push(`${entry} resolves outside the kernel's dist/: ${path.relative(root, file)}`);
    }
  } catch (error) {
    problems.push(`${entry} does not resolve from apps/api: ${error.code ?? error.message}`);
  }
}

if (problems.length === 0) {
  try {
    const kernel = fromApi('@mondapac/shared-kernel');
    const testing = fromApi('@mondapac/shared-kernel/testing');
    const context = testing.testMarketContext('AU', 'mondapac');
    if (!kernel.isMinted(context)) {
      problems.push('a context minted through /testing fails isMinted from the main entry');
    }
  } catch (error) {
    problems.push(`minting through /testing threw: ${error.message}`);
  }
}

if (problems.length > 0) {
  console.error('Built-kernel check failed:');
  for (const problem of problems) console.error(`  - ${problem}`);
  process.exit(1);
}
console.log(
  `Built-kernel check passed: ${[...resolved.values()]
    .map((file) => path.relative(root, file))
    .join(', ')} load one build of the shared kernel.`,
);
