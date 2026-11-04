import {
  canConfirm,
  fileLabelOf,
  isSettled,
  mustSkipErrors,
  rowsToImport,
} from './platform-import-job';

describe('fileLabelOf', () => {
  it('keeps a plain name', () => {
    expect(fileLabelOf('new-products (2).csv')).toBe('new-products (2).csv');
  });
  it('cuts a client path to its last part', () => {
    expect(fileLabelOf('C:\\Users\\a\\x.csv')).toBe('x.csv');
    expect(fileLabelOf('../../etc/passwd')).toBe('passwd');
  });
  it('never echoes markup or control characters', () => {
    expect(fileLabelOf('<img src=x onerror=1>.csv')).not.toMatch(/[<>=]/);
    expect(fileLabelOf('a\u202Eb\n.csv')).not.toMatch(/[\u202E\n]/);
  });
  it('caps the length and falls back for nothing usable', () => {
    expect(fileLabelOf('a'.repeat(500)).length).toBeLessThanOrEqual(80);
    expect(fileLabelOf('<<<>>>')).toBe('import');
    expect(fileLabelOf(42)).toBe('import');
  });
});

describe('job rules', () => {
  it('confirms only a checked job with ready rows', () => {
    expect(canConfirm({ state: 'checked', readyRows: 1 })).toBe(true);
    expect(canConfirm({ state: 'checked', readyRows: 0 })).toBe(false);
    expect(canConfirm({ state: 'running', readyRows: 5 })).toBe(false);
  });
  it('requires an explicit skip when there are errors', () => {
    expect(mustSkipErrors({ errorRows: 1 })).toBe(true);
    expect(mustSkipErrors({ errorRows: 0 })).toBe(false);
    expect(rowsToImport({ readyRows: 7 })).toBe(7);
  });
  it('knows the settled states', () => {
    expect(isSettled('finished')).toBe(true);
    expect(isSettled('stopped')).toBe(true);
    expect(isSettled('running')).toBe(false);
  });
});
