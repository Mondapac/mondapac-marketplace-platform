import type { OnModuleDestroy } from '@nestjs/common';
import { Redis } from 'ioredis';
import type { RateLimitRedisConnection } from '../config/app-config';

/**
 * The longest a counter command may take before it counts as failed (ADR-0054 decision 3): a slow
 * Redis must not add more than this to a request.
 */
export const REDIS_COMMAND_TIMEOUT_MS = 200;
/** The longest one connection attempt may take. */
export const REDIS_CONNECT_TIMEOUT_MS = 1000;
/** The longest the first request after start-up waits for the first connection. */
export const REDIS_FIRST_CONNECTION_WAIT_MS = 1000;

/**
 * The Redis client of the rate-limit counters (ADR-0054), and the only file that imports `ioredis`
 * (`pnpm boundaries`): Redis holds rate-limit counts and nothing else (ADR-0018 decision 2).
 * A platform provider of its own, not part of `PersistenceModule`, which is Prisma only.
 *
 * - Settings: `commandTimeout` 200 ms, no offline queue (a command while disconnected fails at
 *   once, it is never held), no per-request retries, and a reconnect on `READONLY` (a failover
 *   left the client on a replica).
 * - TLS: rediss:// connects with Node's default checks (certificate chain and host name); no
 *   setting switches them off.
 * - Connection: lazy. Nothing connects until the first count, so a process that never counts
 *   (the worker, or a test application whose counters are replaced) never opens a connection.
 * - Errors: the client's `error` events are swallowed here; the counters log the store's state
 *   with a fixed code ({@link redisErrorCode}), never the client's text, which can hold a command's
 *   arguments or the host.
 */
export class RateLimitRedis implements OnModuleDestroy {
  readonly client: Redis;
  #firstConnection: Promise<void> | null = null;

  constructor(connection: RateLimitRedisConnection) {
    this.client = new Redis({
      host: connection.host,
      port: connection.port,
      db: connection.db,
      ...(connection.username === null ? {} : { username: connection.username }),
      ...(connection.password === null ? {} : { password: connection.password }),
      ...(connection.tls ? { tls: { servername: connection.host } } : {}),
      lazyConnect: true,
      enableOfflineQueue: false,
      commandTimeout: REDIS_COMMAND_TIMEOUT_MS,
      connectTimeout: REDIS_CONNECT_TIMEOUT_MS,
      maxRetriesPerRequest: 0,
      // Reconnect in the background, at most every 2 seconds; never give up.
      retryStrategy: (attempt: number) => Math.min(attempt * 200, 2000),
      reconnectOnError: (error: Error) => (error.message.startsWith('READONLY') ? 2 : false),
      // ioredis reads the server's INFO before "ready"; the rate-limit ACL user may run it. No
      // CLIENT SETNAME or SETINFO: the ACL user has no CLIENT command (Hassan's list).
      enableReadyCheck: true,
      disableClientInfo: true,
    });
    this.client.on('error', () => undefined);
  }

  /**
   * Starts the connection on first use and waits for it, at most
   * {@link REDIS_FIRST_CONNECTION_WAIT_MS}, once per process. Later calls return at once: after
   * the first attempt, the client reconnects in the background by itself.
   */
  async firstConnection(): Promise<void> {
    if (this.#firstConnection === null) {
      const connecting = this.client.connect().catch(() => undefined);
      let timer: NodeJS.Timeout | undefined;
      const waited = new Promise<void>((resolve) => {
        timer = setTimeout(resolve, REDIS_FIRST_CONNECTION_WAIT_MS);
        timer.unref();
      });
      this.#firstConnection = Promise.race([connecting, waited]).finally(() => clearTimeout(timer));
    }
    await this.#firstConnection;
  }

  async onModuleDestroy(): Promise<void> {
    if (this.client.status === 'wait' || this.client.status === 'end') return;
    try {
      await this.client.quit();
    } catch {
      this.client.disconnect();
    }
  }
}

/**
 * A fixed code for a failed counter command, for the log: never the error's text. ioredis and
 * rate-limiter-flexible throw plain errors, so the few known texts are mapped to codes.
 */
export function redisErrorCode(error: unknown): string {
  if (!(error instanceof Error)) return 'unknown';
  const message = error.message;
  if (message === 'Command timed out') return 'command-timeout';
  if (message === 'Redis connection is not ready') return 'not-ready';
  if (message.startsWith("Stream isn't writeable")) return 'not-connected';
  if (message === 'Connection is closed.') return 'connection-closed';
  if (message.startsWith('NOPERM')) return 'acl-refused';
  if (message.startsWith('NOAUTH') || message.startsWith('WRONGPASS')) return 'auth-refused';
  if (message.startsWith('READONLY')) return 'read-only-replica';
  if (message.startsWith('OOM')) return 'out-of-memory';
  const code = (error as { code?: unknown }).code;
  if (typeof code === 'string' && /^[A-Z][A-Z0-9_]{1,30}$/.test(code)) return code;
  return 'other';
}
