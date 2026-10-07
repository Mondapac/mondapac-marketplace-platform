import { registerJobs, Temporal } from '../../../platform';

/** A job defined inline in the Nest module, outside presentation/jobs/ (L2). */
export const BETA_JOBS = registerJobs('beta', [
  {
    name: 'beta.purge',
    every: Temporal.Duration.from({ hours: 1 }),
    run: () => Promise.resolve(),
  },
]);
