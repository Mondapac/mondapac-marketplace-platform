// The body of a category or tag the way the blog API takes it.

export const SLUG_PATTERN = /^[a-z0-9]+(-[a-z0-9]+)*$/u;
export const CATEGORY_NAME_MAX = 60;
export const TAG_NAME_MAX = 40;

export interface CategoryForm {
  readonly slug: string;
  readonly names: Readonly<Record<string, string>>;
  readonly position: string;
}

export const blankCategory = (): CategoryForm => ({ slug: '', names: {}, position: '' });

/** The `names` of a body: a name per language, the empty ones left out. */
export function namesOf(form: CategoryForm): Record<string, string> {
  const names: Record<string, string> = {};
  for (const [locale, name] of Object.entries(form.names)) {
    if (name.trim() !== '') names[locale] = name.trim();
  }
  return names;
}

/** The body of a create (slug included) or update (slug left out). */
export function categoryBody(form: CategoryForm, create: boolean): Record<string, unknown> {
  const position = form.position.trim();
  return {
    ...(create ? { slug: form.slug.trim() } : {}),
    names: namesOf(form),
    ...(position === '' ? {} : { position: Number(position) }),
  };
}

/** What stops the form before it is sent; null when it can go. */
export function categoryProblem(
  form: CategoryForm,
  defaultLocale: string,
  create: boolean,
): 'slug' | 'name' | 'position' | null {
  const slug = form.slug.trim();
  if (create && (slug.length < 2 || slug.length > 60 || !SLUG_PATTERN.test(slug))) return 'slug';
  if ((form.names[defaultLocale] ?? '').trim() === '') return 'name';
  const position = form.position.trim();
  if (position !== '' && !/^\d{1,4}$/u.test(position)) return 'position';
  return null;
}

/** The body of a new tag; the address is made from the name when none is given. */
export function tagBody(name: string, slug: string): Record<string, unknown> {
  const address = slug.trim();
  return { name: name.trim(), ...(address === '' ? {} : { slug: address }) };
}
