'use client';

import { RadioGroup } from '../form/radio-group.tsx';

export type ListDirection = 'asc' | 'desc';

export interface ListSortLabels {
  /** The legend of the field choice ("Sort by"). */
  readonly by: string;
  /** The legend of the direction choice ("Order"). */
  readonly order: string;
}

export interface ListSortPanelProps {
  readonly sort: string;
  readonly direction: ListDirection;
  /** The sortable fields with their names. */
  readonly fields: readonly { readonly id: string; readonly label: string }[];
  /** The natural first direction of a field (names A to Z, dates newest first). */
  readonly defaultDirection: (sort: string) => ListDirection;
  /** The two direction names of a field, natural one first ("A to Z", "Z to A"). */
  readonly orderLabels: (sort: string) => readonly [string, string];
  readonly labels: ListSortLabels;
  /** Prefix of the radio group names, so two lists on a page do not share a group. */
  readonly name: string;
  readonly onChange: (sort: string, direction: ListDirection) => void;
}

/**
 * The sort menu (Figma "Sort menu") of a list: one field and the direction, applied as they are
 * chosen. A new field starts in its natural direction.
 */
export function ListSortPanel({
  sort,
  direction,
  fields,
  defaultDirection,
  orderLabels,
  labels,
  name,
  onChange,
}: ListSortPanelProps) {
  const first = defaultDirection(sort);
  const [firstLabel, secondLabel] = orderLabels(sort);
  return (
    <div className="flex flex-col gap-4">
      <RadioGroup
        legend={labels.by}
        name={name}
        value={sort}
        options={fields.map((field) => ({ value: field.id, label: field.label }))}
        onChange={(value) => onChange(value, defaultDirection(value))}
      />
      <div className="border-t border-line-row pt-3">
        <RadioGroup
          legend={labels.order}
          name={`${name}-direction`}
          value={direction}
          options={[
            { value: first, label: firstLabel },
            { value: first === 'asc' ? 'desc' : 'asc', label: secondLabel },
          ]}
          onChange={(value) => onChange(sort, value as ListDirection)}
        />
      </div>
    </div>
  );
}
