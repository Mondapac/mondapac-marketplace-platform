#!/usr/bin/env node
// Prints the admin's current 6-digit authenticator code from the secret the seed saved, for a
// demo without a phone app. Local only: the secret lives in .local/demo-state.json.
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { ROOT } from './guard.mjs';
import { totp } from './lib.mjs';

const file = resolve(ROOT, '.local/demo-state.json');
if (!existsSync(file)) {
  console.error('No demo state yet: run the seed first (node scripts/demo-seed/index.mjs).');
  process.exit(1);
}
const { admin } = JSON.parse(readFileSync(file, 'utf8'));
if (!admin?.secret) {
  console.error('The demo state has no admin secret: run the seed first.');
  process.exit(1);
}
const left = 30 - (Math.floor(Date.now() / 1000) % 30);
console.log(`${totp(admin.secret)}   (valid for about ${left} seconds)`);
