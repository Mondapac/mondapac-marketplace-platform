import { RETIRED_SETTING_CODES, SETTING_CODES } from './definitions';

describe('retired setting codes', () => {
  // A retired code keeps its stored rows (ADR-0026 decision 4); a definition reusing it would put
  // those old values back into force.
  it('are never defined again', () => {
    expect(SETTING_CODES.filter((code) => RETIRED_SETTING_CODES.includes(code))).toEqual([]);
  });
});
