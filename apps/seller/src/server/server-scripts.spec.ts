import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

// ADR-0037 decision 9: `dev` and `start` both run server.mjs, never `next dev` or `server.js`.
describe('package scripts', () => {
  const { scripts } = JSON.parse(readFileSync('package.json', 'utf8')) as {
    scripts: Record<string, string>;
  };

  it('start the panel through server.mjs', () => {
    expect(scripts['dev']).toBe('node server.mjs --dev');
    expect(scripts['start']).toBe('node server.mjs');
  });

  it('server.mjs refuses a start without CLIENT_ADDRESS_SOURCE and uses the wrapper', () => {
    const source = readFileSync('server.mjs', 'utf8');
    expect(source).toContain('parseClientAddressSource(process.env)');
    expect(source).toContain('createPanelServer');
  });
});
