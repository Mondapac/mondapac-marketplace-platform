#!/usr/bin/env node
// Generates apps/api/src/modules/identity/infrastructure/passwords/common-passwords.data.ts,
// the checked-in common-password list of identity design 6.5 (Hassan I1: the generator is
// checked in so the list can be rebuilt and reviewed).
//
// Usage: node scripts/generate-common-passwords.mjs <source-dir>
//
// <source-dir> holds three files downloaded from SecLists (MIT License) at commit or release
// of your choice, under these names:
//   xato100k.txt  Passwords/Common-Credentials/xato-net-10-million-passwords-100000.txt
//   top100k.txt   Passwords/Common-Credentials/100k-most-used-passwords-NCSC.txt
//   LICENSE       the SecLists LICENSE file (its text is copied into the output)
// The script prints the SHA-256 of each list; record them in the commit message. It never
// downloads anything itself (the build stays offline).

import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUTPUT = path.join(
  REPO_ROOT,
  'apps/api/src/modules/identity/infrastructure/passwords/common-passwords.data.ts',
);
const SOURCES = [
  ['xato100k.txt', 'Passwords/Common-Credentials/xato-net-10-million-passwords-100000.txt'],
  ['top100k.txt', 'Passwords/Common-Credentials/100k-most-used-passwords-NCSC.txt'],
];
/** The lowest minimum length any Market may configure (market-config.ts). */
const MIN_LENGTH = 15;

const sourceDir = process.argv[2];
if (!sourceDir) {
  console.error('Usage: node scripts/generate-common-passwords.mjs <source-dir>');
  process.exit(1);
}

const comparable = (value) => value.normalize('NFKC').toLowerCase();

const distinct = new Set();
const described = [];
let total = 0;
for (const [file, origin] of SOURCES) {
  const bytes = readFileSync(path.join(sourceDir, file));
  const lines = bytes
    .toString('utf8')
    .split(/\r?\n/u)
    .filter((line) => line.length > 0);
  total += lines.length;
  for (const line of lines) distinct.add(comparable(line));
  const sha256 = createHash('sha256').update(bytes).digest('hex');
  described.push(`// - ${origin} (${lines.length} entries)`);
  console.log(`${file}: ${lines.length} entries, sha256 ${sha256}`);
}

// Entries holding '@' look like leaked e-mail addresses rather than passwords (Hassan I1);
// they are dropped. Shorter entries are refused by the length rule already.
const kept = [...distinct]
  .filter((entry) => [...entry].length >= MIN_LENGTH && !entry.includes('@'))
  .sort();

const license = readFileSync(path.join(sourceDir, 'LICENSE'), 'utf8')
  .trimEnd()
  .split(/\r?\n/u)
  .map((line) => (line.length > 0 ? `// ${line}` : '//'))
  .join('\n');

const text = `// GENERATED FILE - do not edit by hand; run scripts/generate-common-passwords.mjs.
// Identity design 6.5 (Hassan): a password is refused when it is on a checked-in list of at
// least 100,000 common passwords.
//
// Sources (SecLists, https://github.com/danielmiessler/SecLists, MIT License):
${described.join('\n')}
// ${total} entries in all, ${distinct.size} distinct after Unicode NFKC and lower-casing.
//
// Kept: the ${kept.length} distinct entries of ${MIN_LENGTH} or more code points that hold no '@'.
// Every shorter entry is already refused by the length rule, whose minimum is at least
// ${MIN_LENGTH} in every Market (the Market configuration schema refuses less), so the check
// answers as the full list would. Entries holding '@' look like e-mail addresses, not
// passwords, and are dropped. Entries are NFKC-normalised and lower-cased; the check compares
// the same form.
//
// The list is a substantial portion of SecLists and is distributed under its licence:
//
${license}
export const COMMON_PASSWORDS: readonly string[] = [
${kept.map((entry) => `  ${JSON.stringify(entry)},`).join('\n')}
];
`;

writeFileSync(OUTPUT, text);
console.log(`${kept.length} entries written to ${path.relative(REPO_ROOT, OUTPUT)}`);
