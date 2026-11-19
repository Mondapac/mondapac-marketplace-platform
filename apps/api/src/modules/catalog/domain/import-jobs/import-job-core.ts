// The job core the admin platform import (design 14a) and the seller import (design 14c) share: the
// states a job moves through, the label an upload is shown under and the limits of what a row keeps.
// Pure rules and plain data. The row shapes, the stop reasons and the stores differ between the two
// imports (an admin's job has a start status, a seller's job has a mode and its own tables), so
// they stay with each import; the machine below does not.

/**
 * `checked`: the file was read and checked, nothing else happened. `queued`: confirmed, waiting for
 * the worker (or waiting out a rate window). `running`: the worker holds it. `finished`: every row
 * the run took was tried. `stopped`: the run ended part way and can be resumed. `discarded`: the
 * person left or replaced the file, or the retention removed an unconfirmed check.
 */
export const IMPORT_JOB_STATES = [
  'checked',
  'queued',
  'running',
  'finished',
  'stopped',
  'discarded',
] as const;
export type ImportJobState = (typeof IMPORT_JOB_STATES)[number];

/** The most issues kept for one row (the tables' CHECK). */
export const MAX_ISSUES_PER_ROW = 12;

/** The longest a stored file label is. */
export const FILE_LABEL_MAX = 80;

/**
 * The name an upload is shown under. It is never echoed as sent: only letters, digits, spaces and
 * `. _ ( ) -` stay, the rest becomes a space, the length is capped and a name with nothing left
 * becomes `import`. The path of a client (`C:\\x\\a.csv`) is cut to its last part.
 */
export function fileLabelOf(name: unknown): string {
  if (typeof name !== 'string') return 'import';
  const last = name.split(/[\\/]/).at(-1) ?? '';
  const clean = last
    .normalize('NFKC')
    .replace(/[^\p{L}\p{N} ._()-]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, FILE_LABEL_MAX)
    .trim();
  return clean === '' ? 'import' : clean;
}

/** True when a state is the end of the road for the page's polling. */
export function isSettled(state: ImportJobState): boolean {
  return state === 'finished' || state === 'stopped' || state === 'discarded';
}

/** True when the job can still be confirmed: checked, with at least one ready row. */
export function canConfirm(job: {
  readonly state: ImportJobState;
  readonly readyRows: number;
}): boolean {
  return job.state === 'checked' && job.readyRows > 0;
}

/** True when the rows with errors may be left out only by the person's explicit choice. */
export function mustSkipErrors(job: { readonly errorRows: number }): boolean {
  return job.errorRows > 0;
}
