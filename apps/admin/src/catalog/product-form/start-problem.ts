/** The product exists but the page content of its first save did not all arrive. */
export type StartProblem = 'draft-not-saved' | 'draft-refused';

/**
 * The `?saved=` of the edit URL an Add save leaves behind, as the error the edit page opens with.
 * Only the two values the form writes count; an array or any other value is no problem.
 */
export function startProblemOf(
  saved: string | readonly string[] | undefined,
): StartProblem | undefined {
  if (saved === 'failed') return 'draft-not-saved';
  if (saved === 'refused') return 'draft-refused';
  return undefined;
}
