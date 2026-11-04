// Control characters in file text, by code point (a regular expression over them is refused by the
// repository's lint rules, and a loop is clearer).

function isControl(code: number, allowLayout: boolean): boolean {
  if (code === 0x7f) return true;
  if (code > 0x1f) return false;
  // Tab, line feed and carriage return are layout in a description; every other one is not text.
  return !(allowLayout && (code === 0x09 || code === 0x0a || code === 0x0d));
}

/** True when the text holds a control character PostgreSQL's jsonb refuses or a reader cannot see. */
export function hasControlCharacter(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    if (isControl(value.charCodeAt(index), true)) return true;
  }
  return false;
}

/** The text with every control character (layout ones too) replaced by a space. */
export function replaceControlCharacters(value: string): string {
  let out = '';
  for (let index = 0; index < value.length; index += 1) {
    out += isControl(value.charCodeAt(index), false) ? ' ' : (value[index] ?? '');
  }
  return out;
}
