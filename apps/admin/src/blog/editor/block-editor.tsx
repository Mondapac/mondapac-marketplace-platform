'use client';

import { Button, Select, TextAreaField, TextField } from '@mondapac/ui';
import { useTranslations } from 'next-intl';
import {
  emptyBlock,
  move,
  TEXT_BLOCK_TYPES,
  type EditBlock,
  type TextBlockType,
} from './editor-model.ts';
import { LIMITS } from './types.ts';

/** The first paragraph or so of a kept block, for its read-only card. */
function keptSummary(block: Extract<EditBlock, { type: 'kept' }>['block']): string {
  switch (block.type) {
    case 'image':
      return block.imageId;
    case 'product_cards':
      return String(block.productIds.length);
    case 'seller_card':
      return block.sellerId;
    default:
      return '';
  }
}

/**
 * The body of a post as a list of blocks: text blocks are edited in place, the others are kept as
 * they are. Each block moves up and down and can be removed; a new block goes at the end.
 */
export function BlockEditor({
  blocks,
  onChange,
  disabled,
  reasonAt,
}: {
  readonly blocks: readonly EditBlock[];
  readonly onChange: (next: readonly EditBlock[]) => void;
  readonly disabled: boolean;
  /** The API's reason for a refused path like `body.2.text`, if any. */
  readonly reasonAt: (path: string) => string | undefined;
}) {
  const t = useTranslations('blog.editor');
  const set = (index: number, block: EditBlock) =>
    onChange(blocks.map((entry, i) => (i === index ? block : entry)));
  const errorAt = (index: number): string | undefined => {
    const reason = reasonAt(`content.body.${index}`);
    return reason === undefined ? undefined : t('block.invalid');
  };

  return (
    <div className="flex flex-col gap-4">
      {blocks.length === 0 ? <p className="text-fg-muted">{t('body.empty')}</p> : null}
      <ol className="flex flex-col gap-4">
        {blocks.map((block, index) => {
          const label = t(`block.type.${block.type}`);
          const name = t('block.name', { n: index + 1, type: label });
          return (
            <li
              key={block.key}
              aria-label={name}
              className="flex flex-col gap-3 rounded-lg border border-line bg-surface p-4"
            >
              <div className="flex flex-wrap items-center justify-between gap-2">
                <p className="text-sm font-medium text-fg-muted">{name}</p>
                <div className="flex gap-2">
                  <Button
                    variant="secondary"
                    disabled={disabled || index === 0}
                    aria-label={t('block.up', { n: index + 1 })}
                    onClick={() => onChange(move(blocks, index, index - 1))}
                  >
                    {t('block.up-short')}
                  </Button>
                  <Button
                    variant="secondary"
                    disabled={disabled || index === blocks.length - 1}
                    aria-label={t('block.down', { n: index + 1 })}
                    onClick={() => onChange(move(blocks, index, index + 1))}
                  >
                    {t('block.down-short')}
                  </Button>
                  <Button
                    variant="secondary"
                    disabled={disabled}
                    aria-label={t('block.remove', { n: index + 1 })}
                    onClick={() => onChange(blocks.filter((_, i) => i !== index))}
                  >
                    {t('block.remove-short')}
                  </Button>
                </div>
              </div>
              {block.type === 'paragraph' ? (
                <TextAreaField
                  label={t('block.text')}
                  value={block.text}
                  rows={5}
                  maxLength={LIMITS.paragraph}
                  disabled={disabled}
                  error={errorAt(index)}
                  counter={`${block.text.length} / ${LIMITS.paragraph}`}
                  onChange={(event) => set(index, { ...block, text: event.target.value })}
                />
              ) : null}
              {block.type === 'heading' ? (
                <>
                  <Select
                    label={t('block.level')}
                    value={String(block.level)}
                    disabled={disabled}
                    options={[
                      { value: '2', label: t('block.level-2') },
                      { value: '3', label: t('block.level-3') },
                    ]}
                    onChange={(event) =>
                      set(index, { ...block, level: event.target.value === '3' ? 3 : 2 })
                    }
                  />
                  <TextField
                    label={t('block.text')}
                    value={block.text}
                    maxLength={LIMITS.heading}
                    disabled={disabled}
                    error={errorAt(index)}
                    onChange={(event) => set(index, { ...block, text: event.target.value })}
                  />
                </>
              ) : null}
              {block.type === 'list' ? (
                <>
                  <Select
                    label={t('block.list-kind')}
                    value={block.ordered ? 'ordered' : 'bullets'}
                    disabled={disabled}
                    options={[
                      { value: 'bullets', label: t('block.bullets') },
                      { value: 'ordered', label: t('block.numbered') },
                    ]}
                    onChange={(event) =>
                      set(index, { ...block, ordered: event.target.value === 'ordered' })
                    }
                  />
                  <TextAreaField
                    label={t('block.items')}
                    help={t('block.items-help', { max: LIMITS.listItems })}
                    value={block.text}
                    rows={4}
                    disabled={disabled}
                    error={errorAt(index)}
                    onChange={(event) => set(index, { ...block, text: event.target.value })}
                  />
                </>
              ) : null}
              {block.type === 'quote' ? (
                <>
                  <TextAreaField
                    label={t('block.text')}
                    value={block.text}
                    rows={3}
                    maxLength={LIMITS.quote}
                    disabled={disabled}
                    error={errorAt(index)}
                    counter={`${block.text.length} / ${LIMITS.quote}`}
                    onChange={(event) => set(index, { ...block, text: event.target.value })}
                  />
                  <TextField
                    label={t('block.attribution')}
                    optionalLabel={t('optional')}
                    value={block.by}
                    maxLength={LIMITS.quoteBy}
                    disabled={disabled}
                    onChange={(event) => set(index, { ...block, by: event.target.value })}
                  />
                </>
              ) : null}
              {block.type === 'tip' ? (
                <>
                  <TextField
                    label={t('block.tip-title')}
                    optionalLabel={t('optional')}
                    value={block.title}
                    maxLength={LIMITS.tipTitle}
                    disabled={disabled}
                    onChange={(event) => set(index, { ...block, title: event.target.value })}
                  />
                  <TextAreaField
                    label={t('block.text')}
                    value={block.text}
                    rows={3}
                    maxLength={LIMITS.tip}
                    disabled={disabled}
                    error={errorAt(index)}
                    counter={`${block.text.length} / ${LIMITS.tip}`}
                    onChange={(event) => set(index, { ...block, text: event.target.value })}
                  />
                </>
              ) : null}
              {block.type === 'kept' ? (
                <p className="text-fg-muted">
                  {t(`block.kept.${block.block.type}`, { value: keptSummary(block.block) })}
                </p>
              ) : null}
            </li>
          );
        })}
      </ol>
      <div role="group" aria-label={t('add.label')} className="flex flex-wrap items-center gap-2">
        <span className="text-sm text-fg-muted">{t('add.label')}</span>
        {TEXT_BLOCK_TYPES.map((type: TextBlockType) => (
          <Button
            key={type}
            variant="secondary"
            disabled={disabled || blocks.length >= LIMITS.blocks}
            onClick={() => onChange([...blocks, emptyBlock(type)])}
          >
            {t(`block.type.${type}`)}
          </Button>
        ))}
      </div>
    </div>
  );
}
