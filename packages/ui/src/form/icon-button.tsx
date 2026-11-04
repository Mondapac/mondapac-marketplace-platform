import type { ButtonHTMLAttributes } from 'react';
import { Icon, type IconName } from '../icon/icon.tsx';

export interface IconButtonProps extends Omit<
  ButtonHTMLAttributes<HTMLButtonElement>,
  'aria-label' | 'children'
> {
  readonly icon: IconName;
  /** What the button does; it is its only text, so always give it. */
  readonly label: string;
}

/** Figma IconButton (Ghost, Md): a square icon-only button; the control size keeps it a touch target. */
export function IconButton({ icon, label, className, type = 'button', ...rest }: IconButtonProps) {
  return (
    <button
      type={type}
      aria-label={label}
      title={label}
      className={`inline-flex size-(--mp-size-control-sm) shrink-0 items-center justify-center rounded-md text-icon enabled:hover:bg-muted disabled:text-icon-muted disabled:cursor-not-allowed ${className ?? ''}`}
      {...rest}
    >
      <Icon name={icon} />
    </button>
  );
}
