import { Button } from '../form/button.tsx';
import { Icon } from '../icon/icon.tsx';
import { Tabs, type TabsProps } from '../shell/tabs.tsx';

export interface ListViewsBarProps extends TabsProps {
  /** The "Manage filters" link at the end of the row; null hides it (saved filters did not load). */
  readonly manage: { readonly label: string; readonly onClick: () => void } | null;
}

/**
 * The view tabs of a list (built-in views first, then the saved filters) with the "Manage filters"
 * link at the end of the row. On a phone the link keeps only its icon, named for screen readers.
 */
export function ListViewsBar({ manage, ...tabs }: ListViewsBarProps) {
  return (
    <div className="flex items-stretch">
      <div className="min-w-0 flex-1">
        <Tabs {...tabs} />
      </div>
      {manage === null ? null : (
        <div className="flex shrink-0 items-center border-b border-line ps-3">
          <Button variant="link" className="min-h-(--mp-size-control-sm)" onClick={manage.onClick}>
            <Icon name="sliders" />
            <span className="sr-only sm:not-sr-only">{manage.label}</span>
          </Button>
        </div>
      )}
    </div>
  );
}
