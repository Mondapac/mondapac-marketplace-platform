/** A ServiceArea or boundary file that stops the boot (ADR-0005 decision 7). */
export class InvalidServiceAreaConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'InvalidServiceAreaConfigError';
  }
}
