// Runs ESLint in shards, one child process per shard, one after the other.
//
// Why: the typed rules (`projectService`) keep a TypeScript program in memory for every file
// a run touches, so one `eslint .` over the whole repository (about 6,000 TypeScript files,
// most of them in apps/api) grew to the heap cap and CI's Node-minimum job died with
// "JavaScript heap out of memory" (exit 134). Each shard is its own process, so its memory is
// freed before the next one starts, and the heap cap can stay modest.
//
// Nothing is skipped: the shards partition apps/api/src/modules by module directory, and the
// last shard lints everything that no earlier shard names (`--ignore-pattern`), so a new
// directory or file is linted without editing this script. The rules are unchanged: every
// shard reads the same eslint.config.mjs.
//
// Usage: node scripts/lint.mjs [extra eslint args, e.g. --fix]
import { spawnSync } from 'node:child_process';
import { readdirSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(fileURLToPath(new URL('..', import.meta.url)));
const extraArgs = process.argv.slice(2);
const HEAP_MB = Number(process.env.LINT_HEAP_MB ?? 6144);
// How many shards the API modules are split into.
const MODULE_SHARDS = Number(process.env.LINT_MODULE_SHARDS ?? 4);

const SKIP_DIRS = new Set(['node_modules', 'dist', '.next', 'coverage', 'generated']);

/** Counts lint-relevant source files below a directory (used only to balance the shards). */
function countFiles(dir) {
  let count = 0;
  for (const name of readdirSync(dir)) {
    if (SKIP_DIRS.has(name)) continue;
    const path = join(dir, name);
    const info = statSync(path);
    if (info.isDirectory()) count += countFiles(path);
    else if (/\.(ts|mts|cts|tsx|js|mjs|cjs)$/.test(name)) count += 1;
  }
  return count;
}

// API modules, largest first, each placed on the lightest shard so far.
const modulesDir = 'apps/api/src/modules';
const modules = readdirSync(join(root, modulesDir))
  .filter((name) => statSync(join(root, modulesDir, name)).isDirectory())
  .map((name) => ({
    path: `${modulesDir}/${name}`,
    size: countFiles(join(root, modulesDir, name)),
  }))
  .sort((a, b) => b.size - a.size);
const moduleShards = Array.from({ length: MODULE_SHARDS }, () => ({ paths: [], size: 0 }));
for (const mod of modules) {
  const lightest = moduleShards.reduce((a, b) => (b.size < a.size ? b : a));
  lightest.paths.push(mod.path);
  lightest.size += mod.size;
}

// Whole directories that get their own shard. Files directly in apps/api/src/modules (if any)
// and everything else fall into the last shard.
const shards = [
  ...moduleShards
    .filter((shard) => shard.paths.length > 0)
    .map((shard, index) => ({ name: `api modules ${index + 1}`, paths: shard.paths })),
  { name: 'apps/admin', paths: ['apps/admin'] },
  { name: 'apps/seller', paths: ['apps/seller'] },
  { name: 'apps/web', paths: ['apps/web'] },
  { name: 'packages', paths: ['packages'] },
];
const named = shards.flatMap((shard) => shard.paths);
// Last shard: the rest of apps/api, and any other file of the repository.
shards.push({ name: 'everything else', paths: ['.'], ignore: named });

let failed = 0;
for (const shard of shards) {
  const args = [
    `--max-old-space-size=${HEAP_MB}`,
    './node_modules/eslint/bin/eslint.js',
    ...shard.paths,
    ...(shard.ignore ?? []).flatMap((path) => ['--ignore-pattern', `${path}/**`]),
    ...extraArgs,
  ];
  console.log(
    `\n== eslint: ${shard.name} (${shard.paths.length} path${shard.paths.length === 1 ? '' : 's'})`,
  );
  const started = Date.now();
  const result = spawnSync(process.execPath, args, { cwd: root, stdio: 'inherit' });
  const seconds = Math.round((Date.now() - started) / 1000);
  if (result.status !== 0) {
    failed += 1;
    console.error(
      `== eslint: ${shard.name} FAILED (exit ${result.status ?? result.signal}) after ${seconds}s`,
    );
  } else {
    console.log(`== eslint: ${shard.name} ok in ${seconds}s`);
  }
}
if (failed > 0) {
  console.error(`\nESLint failed in ${failed} of ${shards.length} shards.`);
  process.exit(1);
}
