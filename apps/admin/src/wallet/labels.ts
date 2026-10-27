/** A server code that may select a message: lower-case words joined by hyphens, no dots. */
const CODE_SHAPE = /^[a-z]+(-[a-z]+)*$/;

type Translate = ((key: string) => string) & { has: (key: string) => boolean };

/**
 * The message for `group.code`, or the raw code when it has the wrong shape or no message. A code
 * from the server never picks a namespace or a nested key (`x.y`), only a leaf of the group.
 */
export function wordFor(t: Translate, group: string, code: string | null): string {
  if (code === null) return '';
  return CODE_SHAPE.test(code) && t.has(`${group}.${code}`) ? t(`${group}.${code}`) : code;
}
