import { languageName, type AttributeChange } from './types.ts';

/**
 * How one History change reads, as a message key and its values. The API names a change by
 * field (`name.{locale}`, `material`, `isVariantOption`, `bounds.{key}`, `option.{code}.added`,
 * `option.{code}.label.{locale}`, `option.{code}.active`, `option.{code}.position`, and from
 * package A2 `help.{locale}`, the display flags, `position` and `internalNote`, whose value is
 * never sent); an unknown field still shows, by its raw name.
 */
export type ChangeLine =
  | { readonly key: 'name'; readonly language: string }
  | { readonly key: 'material' | 'variant' }
  | { readonly key: 'help'; readonly language: string }
  | {
      readonly key:
        'show-on-product-page' | 'searchable' | 'can-be-filter' | 'position' | 'internal-note';
    }
  | { readonly key: 'bound'; readonly bound: string }
  | { readonly key: 'measure'; readonly setting: string }
  | { readonly key: 'option-added' | 'option-removed'; readonly code: string }
  | { readonly key: 'option-label'; readonly code: string; readonly language: string }
  | { readonly key: 'option-active' | 'option-position'; readonly code: string }
  | { readonly key: 'other'; readonly field: string };

const OPTION_LABEL = /^option\.(.+)\.label\.([A-Za-z0-9-]+)$/;
const OPTION_PART = /^option\.(.+)\.(added|removed|active|position)$/;

export function changeLineOf(
  change: AttributeChange,
  supported: readonly string[] = [],
): ChangeLine {
  const { field } = change;
  if (field.startsWith('name.'))
    return { key: 'name', language: languageName(field.slice(5), supported) };
  if (field === 'material') return { key: 'material' };
  if (field === 'isVariantOption') return { key: 'variant' };
  if (field.startsWith('help.'))
    return { key: 'help', language: languageName(field.slice(5), supported) };
  if (field === 'showOnProductPage') return { key: 'show-on-product-page' };
  if (field === 'searchable') return { key: 'searchable' };
  if (field === 'canBeFilter') return { key: 'can-be-filter' };
  if (field === 'position') return { key: 'position' };
  if (field === 'internalNote') return { key: 'internal-note' };
  if (field.startsWith('measure.')) return { key: 'measure', setting: field.slice(8) };
  if (field.startsWith('bounds.')) return { key: 'bound', bound: field.slice(7) };
  const label = OPTION_LABEL.exec(field);
  if (label !== null) {
    return {
      key: 'option-label',
      code: label[1] ?? '',
      language: languageName(label[2] ?? '', supported),
    };
  }
  const part = OPTION_PART.exec(field);
  if (part !== null) {
    const code = part[1] ?? '';
    if (part[2] === 'added') return { key: 'option-added', code };
    if (part[2] === 'removed') return { key: 'option-removed', code };
    return { key: part[2] === 'active' ? 'option-active' : 'option-position', code };
  }
  return { key: 'other', field };
}
