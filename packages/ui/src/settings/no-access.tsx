import { EmptyState } from '../form/empty-state.tsx';
import { LinkButton } from '../form/button.tsx';

export interface NoAccessProps {
  /** "You don't have access to this page" */
  readonly title: string;
  /** Names the permission in plain words and who can grant it. */
  readonly body: string;
  readonly backHref: string;
  readonly backLabel: string;
}

/** The one "no access" block of a page whose view permission the actor lacks. It is the page h1. */
export function NoAccess({ title, body, backHref, backLabel }: NoAccessProps) {
  return (
    <EmptyState
      size="page"
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
}
