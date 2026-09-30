import { existsSync } from 'node:fs';
import path from 'node:path';

/**
 * Loads the repository's `.env` file for local development, if there is one. Variables
 * already set in the environment win, so deployed environments are unaffected.
 */
export function loadEnvFile(): void {
  // apps/api/{src|dist} -> repository root
  const file = path.resolve(__dirname, '../../../.env');
  if (existsSync(file)) process.loadEnvFile(file);
}
