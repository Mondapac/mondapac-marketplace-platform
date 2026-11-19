import { useRowSelection } from '@mondapac/ui';
import { QueueTable } from '../../src/certificates/queue-list/queue-table.tsx';
import type { QueueListRow } from '../../src/certificates/queue-list/queue-types.ts';

// The queue table over fixed rows, for the screenshot pages (no API, no list around it).
export function QueueDemo({
  rows,
  typeNames,
}: {
  readonly rows: readonly QueueListRow[];
  readonly typeNames: ReadonlyMap<string, string>;
}) {
  const selection = useRowSelection(
    rows.map((row) => row.certificateId),
    200,
    'demo',
  );
  return (
    <QueueTable
      rows={rows}
      columns={['submission-no']}
      typeNames={typeNames}
      zone="Australia/Brisbane"
      selection={selection}
      actions={(row) =>
        row.actions.map((action) => ({
          id: action,
          label: action === 'decide' ? 'Decide…' : 'Open',
          onSelect: () => undefined,
        }))
      }
    />
  );
}
