interface Handler {
  handle(): number;
}

// Allowed: outside use-cases/ and presentation/, a `.handle(` on an unrelated handler object
// is not the gate.
export const run = (handler: Handler): number => handler.handle();
export class Declares {
  execute(): number {
    return 1;
  }
}
