// Violation: a use case implements handle and never overrides execute.
export class OverridesExecute {
  async execute(): Promise<number> {
    return Promise.resolve(1);
  }
}
