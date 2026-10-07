class Other {
  handle(): number {
    return 1;
  }
}

// Violation: handle is called by UseCase.execute only, never on another use case.
export const violation = new Other().handle();
