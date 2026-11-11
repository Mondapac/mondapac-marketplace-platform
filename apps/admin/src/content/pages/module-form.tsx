'use client';

import { Button, IconButton, Select, TextField } from '@mondapac/ui';
import { useTranslations } from 'next-intl';
import { IMAGE_KEYS } from '../slides/slide-types.ts';
import {
  BLANK_BLOCKS,
  BLOCK_TYPES,
  MODULE_SCHEMAS,
  SHELF_SOURCES_V1,
  getAt,
  moved,
  pathText,
  setAt,
  type FieldSpec,
  type Path,
} from './module-schema.ts';

/** The API's problems of a save, by path (`config.items[0].text`), as codes. */
export type FieldCodes = ReadonlyMap<string, string>;

interface Ctx {
  readonly draft: Record<string, unknown>;
  readonly errors: FieldCodes;
  readonly set: (path: Path, value: unknown) => void;
}

const text = (value: unknown): string => (typeof value === 'string' ? value : '');
const list = (value: unknown): unknown[] => (Array.isArray(value) ? value : []);

/** The settings form of one module. `draft` is the module's settings; `onChange` gets a copy. */
export function ModuleForm({
  module,
  draft,
  errors,
  onChange,
}: {
  readonly module: string;
  readonly draft: Record<string, unknown>;
  readonly errors: FieldCodes;
  readonly onChange: (next: Record<string, unknown>) => void;
}) {
  const ctx: Ctx = {
    draft,
    errors,
    set: (path, value) => onChange(setAt(draft, path, value)),
  };
  return (
    <div className="flex flex-col gap-4">
      {(MODULE_SCHEMAS[module] ?? []).map((spec) => (
        <Field key={spec.key} spec={spec} path={[spec.key]} ctx={ctx} />
      ))}
    </div>
  );
}

function useErrorText() {
  const t = useTranslations('content.pages.editor.error');
  return (code: string | undefined, max?: number, kind?: string): string | undefined => {
    if (code === undefined) return undefined;
    if (code === 'required') return t('required');
    if (code === 'length') return kind === 'link' ? t('link') : t('length', { max: max ?? 0 });
    if (code === 'format') return t(kind === 'link' ? 'link' : 'format');
    return t('other');
  };
}

function useLabels() {
  const t = useTranslations('content.pages.editor');
  return {
    label: (key: string) => t(`field.${key}`),
    help: (key: string) => (t.has(`field.${key}-help`) ? t(`field.${key}-help`) : undefined),
    option: (key: string, value: string) =>
      t.has(`option.${key}.${value}`) ? t(`option.${key}.${value}`) : value,
    t,
  };
}

function Field({
  spec,
  path,
  ctx,
}: {
  readonly spec: FieldSpec;
  readonly path: Path;
  readonly ctx: Ctx;
}) {
  const { label, help, option, t } = useLabels();
  const errorText = useErrorText();
  const at = pathText(['config', ...path]);
  const value = getAt(ctx.draft, path);
  const code = ctx.errors.get(at);
  switch (spec.kind) {
    case 'text':
      return (
        <TextField
          label={label(spec.key)}
          value={text(value)}
          autoComplete="off"
          error={errorText(code, spec.max)}
          help={help(spec.key) ?? t('hint-max', { max: spec.max })}
          {...(spec.optional === true ? { optionalLabel: t('optional') } : {})}
          onChange={(event) => ctx.set(path, event.target.value)}
        />
      );
    case 'link':
      return (
        <TextField
          label={label(spec.key)}
          value={text(value)}
          autoComplete="off"
          autoCapitalize="none"
          spellCheck={false}
          dir="ltr"
          error={errorText(code, undefined, 'link')}
          help={t('hint-link')}
          {...(spec.optional === true ? { optionalLabel: t('optional') } : {})}
          onChange={(event) => ctx.set(path, event.target.value)}
        />
      );
    case 'int':
      return (
        <TextField
          label={label(spec.key)}
          type="number"
          inputMode="numeric"
          min={spec.min}
          max={spec.max}
          value={typeof value === 'number' ? String(value) : text(value)}
          error={
            code === undefined ? undefined : t('error.range', { min: spec.min, max: spec.max })
          }
          help={t('hint-range', { min: spec.min, max: spec.max })}
          onChange={(event) => {
            const next = event.target.value;
            ctx.set(path, next === '' ? '' : Number(next));
          }}
        />
      );
    case 'choice':
      return (
        <Select
          label={label(spec.key)}
          value={text(value) || spec.options[0] || ''}
          options={spec.options.map((entry) => ({ value: entry, label: option(spec.key, entry) }))}
          error={code === undefined ? undefined : t('error.other')}
          onChange={(event) => ctx.set(path, event.target.value)}
        />
      );
    case 'image':
      return <ImageField spec={spec} path={path} ctx={ctx} />;
    case 'source':
      return <SourceField path={path} ctx={ctx} />;
    case 'spans':
      return <SpansField label={label(spec.key)} path={path} ctx={ctx} />;
    case 'blocks':
      return <BlocksField path={path} ctx={ctx} />;
    case 'list':
      return <ListField spec={spec} path={path} ctx={ctx} />;
  }
}

/** Up, down and remove for one row of a list. */
function RowTools({
  index,
  count,
  min,
  onMove,
  onRemove,
  name,
}: {
  readonly index: number;
  readonly count: number;
  readonly min: number;
  readonly onMove: (by: -1 | 1) => void;
  readonly onRemove: () => void;
  readonly name: string;
}) {
  const t = useTranslations('content.pages.editor.tools');
  return (
    <div className="flex shrink-0 items-center">
      <IconButton
        icon="chevron-up"
        label={t('up', { name })}
        disabled={index === 0}
        onClick={() => onMove(-1)}
      />
      <IconButton
        icon="chevron-down"
        label={t('down', { name })}
        disabled={index === count - 1}
        onClick={() => onMove(1)}
      />
      <IconButton
        icon="trash"
        label={t('remove', { name })}
        disabled={count <= min}
        onClick={onRemove}
      />
    </div>
  );
}

/** Rows of a list at `path`, each in a fieldset, with move and remove, and Add under them. */
function Rows({
  path,
  ctx,
  min,
  max,
  blank,
  legend,
  addLabel,
  children,
  name,
}: {
  readonly path: Path;
  readonly ctx: Ctx;
  readonly min: number;
  readonly max: number;
  readonly blank: () => unknown;
  readonly legend: string;
  readonly addLabel: string;
  readonly name: (index: number) => string;
  readonly children: (index: number) => React.ReactNode;
}) {
  const t = useTranslations('content.pages.editor');
  const rows = list(getAt(ctx.draft, path));
  const code = ctx.errors.get(pathText(['config', ...path]));
  return (
    <fieldset className="m-0 flex min-w-0 flex-col gap-3 border-0 p-0">
      <legend className="mb-1 p-0 text-sm font-medium text-fg">{legend}</legend>
      {code === undefined ? null : (
        <p role="alert" className="text-sm text-critical-fg">
          {t(code === 'required' ? 'error.list-required' : 'error.other')}
        </p>
      )}
      {rows.map((_, index) => (
        <div
          // Rows have no id of their own; the position is the identity while editing.
          key={index}
          className="flex min-w-0 flex-col gap-3 rounded-md border border-line bg-muted/40 p-3"
        >
          <div className="flex items-center justify-between gap-2">
            <p className="text-sm font-medium text-fg">{name(index)}</p>
            <RowTools
              index={index}
              count={rows.length}
              min={min}
              name={name(index)}
              onMove={(by) => ctx.set(path, moved(rows, index, by))}
              onRemove={() =>
                ctx.set(
                  path,
                  rows.filter((_row, position) => position !== index),
                )
              }
            />
          </div>
          {children(index)}
        </div>
      ))}
      <div>
        <Button
          variant="secondary"
          disabled={rows.length >= max}
          onClick={() => ctx.set(path, [...rows, blank()])}
        >
          {addLabel}
        </Button>
        {rows.length >= max ? (
          <p className="mt-1 text-sm text-fg-muted">{t('list-full', { max })}</p>
        ) : null}
      </div>
    </fieldset>
  );
}

function ListField({
  spec,
  path,
  ctx,
}: {
  readonly spec: Extract<FieldSpec, { kind: 'list' }>;
  readonly path: Path;
  readonly ctx: Ctx;
}) {
  const { label, t } = useLabels();
  return (
    <Rows
      path={path}
      ctx={ctx}
      min={spec.min}
      max={spec.max}
      blank={() => structuredClone(spec.blank)}
      legend={label(spec.key)}
      addLabel={t('add-item')}
      name={(index) => t('item', { n: index + 1 })}
    >
      {(index) => (
        <>
          {spec.item.map((entry) => (
            <Field key={entry.key} spec={entry} path={[...path, index, entry.key]} ctx={ctx} />
          ))}
        </>
      )}
    </Rows>
  );
}

/** Plain text in parts, each part optionally a link: the shape of every paragraph of a module. */
function SpansField({
  label,
  path,
  ctx,
}: {
  readonly label: string;
  readonly path: Path;
  readonly ctx: Ctx;
}) {
  const { t } = useLabels();
  const errorText = useErrorText();
  const rows = list(getAt(ctx.draft, path));
  return (
    <Rows
      path={path}
      ctx={ctx}
      min={1}
      max={20}
      blank={() => ({ text: '' })}
      legend={label}
      addLabel={t('add-part')}
      name={(index) => t('part', { n: index + 1 })}
    >
      {(index) => (
        <>
          <TextField
            label={t('field.text')}
            value={text(getAt(rows[index], ['text']))}
            autoComplete="off"
            error={errorText(ctx.errors.get(pathText(['config', ...path, index, 'text'])), 1000)}
            help={t('hint-max', { max: 1000 })}
            onChange={(event) => ctx.set([...path, index, 'text'], event.target.value)}
          />
          <TextField
            label={t('field.href')}
            value={text(getAt(rows[index], ['href']))}
            autoComplete="off"
            autoCapitalize="none"
            spellCheck={false}
            dir="ltr"
            optionalLabel={t('optional')}
            error={errorText(
              ctx.errors.get(pathText(['config', ...path, index, 'href'])),
              undefined,
              'link',
            )}
            help={t('hint-link')}
            onChange={(event) => ctx.set([...path, index, 'href'], event.target.value)}
          />
        </>
      )}
    </Rows>
  );
}

function BlocksField({ path, ctx }: { readonly path: Path; readonly ctx: Ctx }) {
  const { label, option, t } = useLabels();
  const errorText = useErrorText();
  const blocks = list(getAt(ctx.draft, path));
  return (
    <Rows
      path={path}
      ctx={ctx}
      min={1}
      max={40}
      blank={() => structuredClone(BLANK_BLOCKS.paragraph)}
      legend={label('blocks')}
      addLabel={t('add-block')}
      name={(index) => t('block', { n: index + 1 })}
    >
      {(index) => {
        const block = blocks[index];
        const type = text(getAt(block, ['type'])) || 'paragraph';
        const here: Path = [...path, index];
        return (
          <>
            <Select
              label={t('field.type')}
              value={type}
              options={BLOCK_TYPES.map((entry) => ({
                value: entry,
                label: option('type', entry),
              }))}
              onChange={(event) => {
                const next = event.target.value as (typeof BLOCK_TYPES)[number];
                ctx.set(here, structuredClone(BLANK_BLOCKS[next]));
              }}
            />
            {type === 'heading' ? (
              <>
                <Select
                  label={t('field.level')}
                  value={getAt(block, ['level']) === 3 ? '3' : '2'}
                  options={['2', '3'].map((entry) => ({
                    value: entry,
                    label: option('level', entry),
                  }))}
                  onChange={(event) => ctx.set([...here, 'level'], Number(event.target.value))}
                />
                <TextField
                  label={t('field.text')}
                  value={text(getAt(block, ['text']))}
                  autoComplete="off"
                  error={errorText(ctx.errors.get(pathText(['config', ...here, 'text'])), 160)}
                  help={t('hint-max', { max: 160 })}
                  onChange={(event) => ctx.set([...here, 'text'], event.target.value)}
                />
              </>
            ) : null}
            {type === 'paragraph' ? (
              <SpansField label={t('field.spans')} path={[...here, 'spans']} ctx={ctx} />
            ) : null}
            {type === 'list' ? (
              <Rows
                path={[...here, 'items']}
                ctx={ctx}
                min={1}
                max={30}
                blank={() => [{ text: '' }]}
                legend={t('field.items')}
                addLabel={t('add-item')}
                name={(position) => t('item', { n: position + 1 })}
              >
                {(position) => (
                  <SpansField
                    label={t('field.spans')}
                    path={[...here, 'items', position]}
                    ctx={ctx}
                  />
                )}
              </Rows>
            ) : null}
          </>
        );
      }}
    </Rows>
  );
}

function ImageField({
  spec,
  path,
  ctx,
}: {
  readonly spec: Extract<FieldSpec, { kind: 'image' }>;
  readonly path: Path;
  readonly ctx: Ctx;
}) {
  const { label } = useLabels();
  const errorText = useErrorText();
  const at = pathText(['config', ...path]);
  return (
    <ImageInputs
      legend={label(spec.key)}
      optional={spec.optional === true}
      image={getAt(ctx.draft, path)}
      refError={errorText(ctx.errors.get(`${at}.ref`) ?? ctx.errors.get(at))}
      altError={errorText(ctx.errors.get(`${at}.alt`), 160)}
      onChange={(next) => ctx.set(path, next)}
    />
  );
}

/**
 * A ready-made picture and its description (alt text, required with a picture). Also used by the
 * page settings for the share image. `onChange` gets `{ ref, alt }` as typed so far.
 */
export function ImageInputs({
  legend,
  optional,
  image,
  refError,
  altError,
  onChange,
}: {
  readonly legend: string;
  readonly optional: boolean;
  readonly image: unknown;
  readonly refError?: string | undefined;
  readonly altError?: string | undefined;
  readonly onChange: (next: { readonly ref: string; readonly alt: string }) => void;
}) {
  const t = useTranslations('content.pages.editor');
  const names = useTranslations('content.slides.editor');
  const ref = text(getAt(image, ['ref']));
  const alt = text(getAt(image, ['alt']));
  const known = (IMAGE_KEYS as readonly string[]).includes(ref);
  const options = [
    ...IMAGE_KEYS.map((key) => ({ value: key, label: names(`image-key.${key}`) })),
    // An image the template put there (or another set) stays selectable as it is.
    ...(ref === '' || known ? [] : [{ value: ref, label: t('image-other', { key: ref }) }]),
  ];
  return (
    <fieldset className="m-0 flex min-w-0 flex-col gap-3 border-0 p-0">
      <legend className="mb-1 p-0 text-sm font-medium text-fg">
        {legend}
        {optional ? (
          <span className="ms-1 font-normal text-fg-muted">({t('optional')})</span>
        ) : null}
      </legend>
      <Select
        label={t('field.image-ref')}
        value={ref}
        placeholder={optional ? t('image-none') : t('image-choose')}
        options={options}
        help={t('image-help')}
        error={refError}
        onChange={(event) => onChange({ ref: event.target.value, alt })}
      />
      <TextField
        label={t('field.image-alt')}
        value={alt}
        autoComplete="off"
        error={altError}
        help={t('image-alt-help')}
        onChange={(event) => onChange({ ref, alt: event.target.value })}
      />
    </fieldset>
  );
}

/** Where a shelf takes its products from: v1 offers three; another one already set is kept. */
function SourceField({ path, ctx }: { readonly path: Path; readonly ctx: Ctx }) {
  const { label, option, t } = useLabels();
  const kind = text(getAt(ctx.draft, [...path, 'kind'])) || 'bestsellers';
  const offered: readonly string[] = (SHELF_SOURCES_V1 as readonly string[]).includes(kind)
    ? SHELF_SOURCES_V1
    : [...SHELF_SOURCES_V1, kind];
  const at = pathText(['config', ...path]);
  const code = ctx.errors.get(at) ?? ctx.errors.get(`${at}.kind`);
  return (
    <>
      <Select
        label={label('source')}
        value={kind}
        options={offered.map((entry) => ({ value: entry, label: option('source', entry) }))}
        error={code === undefined ? undefined : t('error.other')}
        help={
          (SHELF_SOURCES_V1 as readonly string[]).includes(kind)
            ? t(`source-help.${kind}`)
            : t('source-kept')
        }
        onChange={(event) => ctx.set(path, { kind: event.target.value })}
      />
    </>
  );
}
