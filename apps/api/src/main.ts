import 'reflect-metadata';
import { loadEnvFile } from './load-env-file';
import { loadAppConfig } from './platform/config/app-config';
import { startApi } from './start-api';
import { startWorker } from './start-worker';

/**
 * The composition root (platform persistence design, "P", 8). It reads `APP_ROLE` and
 * branches once: `api` serves HTTP, `worker` runs the relay and the scheduler. Both build the
 * same module graph. Only this file and `platform/worker/` read the role (P 12.2 rule 3).
 */
async function bootstrap(): Promise<void> {
  loadEnvFile();
  const config = loadAppConfig(process.env);

  if (config.appRole === 'worker') {
    const worker = await startWorker(config);
    if (worker === undefined) process.exit(1);
    for (const signal of ['SIGTERM', 'SIGINT'] as const) {
      process.once(signal, () => {
        worker.stop().then(
          () => process.exit(0),
          () => process.exit(1),
        );
      });
    }
    return;
  }

  const api = await startApi(config);
  if (api === undefined) process.exit(1);
}

bootstrap().catch((error: unknown) => {
  // Startup failures (for example invalid configuration) happen before the logger exists.
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
