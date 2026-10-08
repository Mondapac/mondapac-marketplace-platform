import { request as httpRequest, Agent, type IncomingMessage, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import { applyClientAddress, parseClientAddressSource } from './client-address-source.ts';
import { createPanelServer } from './server.ts';

interface Seen {
  headers: Record<string, string | string[] | undefined>;
  rawHeaders: string[];
}

let server: Server | undefined;
afterEach(() => {
  server?.close();
  server?.closeAllConnections();
  server = undefined;
});

async function start(env: Record<string, string>, host = '127.0.0.1') {
  const seen: Seen[] = [];
  const warnings: { reason: string; peer: string }[] = [];
  server = createPanelServer({
    source: parseClientAddressSource(env),
    warn: (line) => warnings.push(line),
    handle: (req: IncomingMessage, res) => {
      seen.push({ headers: { ...req.headers }, rawHeaders: [...req.rawHeaders] });
      res.end('ok');
    },
  });
  await new Promise<void>((done) => server!.listen(0, host, done));
  return { seen, warnings, port: (server.address() as AddressInfo).port, host };
}

function send(
  target: { port: number; host: string },
  rawHeaders: readonly string[],
  agent?: Agent,
): Promise<number> {
  return new Promise((resolve, reject) => {
    const req = httpRequest(
      {
        host: target.host,
        port: target.port,
        path: '/',
        headers: ['Host', `${target.host}:${target.port}`, ...rawHeaders],
        agent,
      },
      (res) => {
        res.resume();
        res.on('end', () => resolve(res.statusCode ?? 0));
      },
    );
    req.on('error', reject);
    req.end();
  });
}

const SPOOFS = [
  'X-Forwarded-For',
  '9.9.9.9',
  'x-forwarded-for',
  '8.8.8.8',
  'Forwarded',
  'for=7.7.7.7',
  'X-Real-IP',
  '6.6.6.6',
  'X-Client-Address',
  'v1;k=panel;t=1;a=5.5.5.5;s=x',
  'X-MP-Client-Address',
  '4.4.4.4',
];

describe('socket mode', () => {
  it('drops every spoofed header and sets the peer address', async () => {
    const target = await start({ CLIENT_ADDRESS_SOURCE: 'socket' });
    expect(await send(target, SPOOFS)).toBe(200);
    const [only] = target.seen;
    expect(only?.headers['x-mp-client-address']).toBe('127.0.0.1');
    for (const name of ['x-forwarded-for', 'forwarded', 'x-real-ip', 'x-client-address']) {
      expect(only?.headers[name]).toBeUndefined();
    }
    const names = (only?.rawHeaders ?? [])
      .filter((_, index) => index % 2 === 0)
      .map((n) => n.toLowerCase());
    expect(names.filter((name) => name === 'x-mp-client-address')).toHaveLength(1);
    expect(names).not.toContain('x-forwarded-for');
    expect(names).not.toContain('forwarded');
  });
});

describe('an IPv6 peer', () => {
  const fake = (remoteAddress: string, rawHeaders: string[] = []) =>
    ({ socket: { remoteAddress }, headers: {}, rawHeaders }) as unknown as IncomingMessage;

  it('is its own address in socket mode, and an IPv4-mapped peer is its IPv4 address', () => {
    const v6 = fake('2001:db8::7');
    expect(applyClientAddress(v6, { mode: 'socket' })).toBe(true);
    expect(v6.headers['x-mp-client-address']).toBe('2001:db8::7');
    const mapped = fake('::ffff:203.0.113.9');
    applyClientAddress(mapped, { mode: 'socket' });
    expect(mapped.headers['x-mp-client-address']).toBe('203.0.113.9');
  });

  it('is matched against IPv6 edge ranges', () => {
    const source = parseClientAddressSource({
      CLIENT_ADDRESS_SOURCE: 'edge',
      EDGE_CIDRS: '2001:db8:1::/48',
      EDGE_CLIENT_ADDRESS_HEADER: 'x-edge',
    });
    const inside = fake('2001:db8:1::5', ['X-Edge', '203.0.113.50']);
    expect(applyClientAddress(inside, source)).toBe(true);
    expect(inside.headers['x-mp-client-address']).toBe('203.0.113.50');
    expect(applyClientAddress(fake('2001:db8:1::5'), source)).toBe(false);
  });
});

describe('edge mode', () => {
  const edge = {
    CLIENT_ADDRESS_SOURCE: 'edge',
    EDGE_CIDRS: '127.0.0.0/16',
    EDGE_CLIENT_ADDRESS_HEADER: 'cf-connecting-ip',
  };

  it('uses the edge header from a peer inside the ranges, and removes it', async () => {
    const target = await start(edge);
    expect(await send(target, ['CF-Connecting-IP', '203.0.113.7', ...SPOOFS])).toBe(200);
    const [only] = target.seen;
    expect(only?.headers['x-mp-client-address']).toBe('203.0.113.7');
    expect(only?.headers['cf-connecting-ip']).toBeUndefined();
  });

  it('accepts an IPv6 edge value', async () => {
    const target = await start(edge);
    await send(target, ['cf-connecting-ip', '2001:db8:1:2::7']);
    expect(target.seen[0]?.headers['x-mp-client-address']).toBe('2001:db8:1:2::7');
  });

  it('ignores the edge header from a peer outside the ranges', async () => {
    const target = await start({ ...edge, EDGE_CIDRS: '203.0.113.0/24' });
    await send(target, ['cf-connecting-ip', '9.9.9.9']);
    expect(target.seen[0]?.headers['x-mp-client-address']).toBe('127.0.0.1');
    expect(target.seen[0]?.headers['cf-connecting-ip']).toBeUndefined();
  });

  it.each([
    ['missing', []],
    ['repeated', ['cf-connecting-ip', '1.1.1.1', 'CF-Connecting-IP', '2.2.2.2']],
    ['comma-joined', ['cf-connecting-ip', '1.1.1.1, 2.2.2.2']],
    ['with a port', ['cf-connecting-ip', '1.1.1.1:443']],
    ['in brackets', ['cf-connecting-ip', '[2001:db8::1]']],
    ['with a zone', ['cf-connecting-ip', 'fe80::1%eth0']],
    ['not an address', ['cf-connecting-ip', 'hello']],
    ['empty', ['cf-connecting-ip', '']],
    ['XFF only', ['x-forwarded-for', '1.1.1.1']],
  ])('answers 400 for an edge peer with a %s value, with no fallback', async (_name, headers) => {
    const target = await start(edge);
    expect(await send(target, headers)).toBe(400);
    expect(target.seen).toHaveLength(0);
    // One warning per refusal: the reason and the peer, never the header value.
    expect(target.warnings).toHaveLength(1);
    expect(target.warnings[0]?.peer).toBe('127.0.0.1');
    expect(JSON.stringify(target.warnings)).not.toMatch(/1\.1\.1\.1|hello|fe80/);
  });

  it('reads the edge value again on every request of one keep-alive connection', async () => {
    const target = await start(edge);
    const agent = new Agent({ keepAlive: true, maxSockets: 1 });
    await send(target, ['cf-connecting-ip', '203.0.113.1'], agent);
    await send(target, ['cf-connecting-ip', '203.0.113.2'], agent);
    await send(target, ['cf-connecting-ip', '203.0.113.3'], agent);
    agent.destroy();
    expect(target.seen.map((entry) => entry.headers['x-mp-client-address'])).toEqual([
      '203.0.113.1',
      '203.0.113.2',
      '203.0.113.3',
    ]);
  });
});
