// Validates the future-enhancements register (docs/future-enhancements/items/*.json).
// The checker is Python (stdlib only); try python3, then python, then the Windows launcher.
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const script = fileURLToPath(new URL('../docs/future-enhancements/generate.py', import.meta.url));
for (const [cmd, pre] of [
  ['python3', []],
  ['python', []],
  ['py', ['-3']],
]) {
  const r = spawnSync(cmd, [...pre, script, '--check'], { stdio: 'inherit' });
  if (r.error?.code === 'ENOENT') continue;
  process.exit(r.status ?? 1);
}
console.error('future-enhancements check needs Python 3 (python3, python or py -3) on PATH');
process.exit(1);
