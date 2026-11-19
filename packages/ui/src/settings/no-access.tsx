import { EmptyState } from '../form/empty-state.tsx';
import { LinkButton } from '../form/button.tsx';

export interface NoAccessProps {
  /** "You don't have access to this page" */
  readonly title: string;
  /** Names the permission in plain words and who can grant it. */
  readonly body: string;
  readonly backHref: string;
  readonly backLabel: string;
  /**
   * The page's own name. A settings page passes it: the block is then a card inside the page's
   * layout, under the page's h1. Without it the block is the whole page and its title is the h1.
   */
  readonly pageTitle?: string;
}

/** The one "no access" block of a page whose view permission the actor lacks. */
export function NoAccess({ title, body, backHref, backLabel, pageTitle }: NoAccessProps) {
  const block = (
    <EmptyState
      size={pageTitle === undefined ? 'page' : 'card'}
      icon="lock"
      title={title}
      body={body}
      action={
        <LinkButton variant="secondary" href={backHref}>
          {backLabel}
        </LinkButton>
      }
    />
  );
  if (pageTitle === undefined) return block;
  return (
    <div className="flex flex-col gap-4">
      <h1 className="text-2xl font-semibold text-fg">{pageTitle}</h1>
      {block}
    </div>
  );
}
