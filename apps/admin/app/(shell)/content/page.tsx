import { redirect } from 'next/navigation';
import { SLIDES_PATH } from '../../../src/content/slides/slide-types.ts';

/** Slides is the only Content tab so far, so Content opens on it. */
export default function ContentPage() {
  redirect(SLIDES_PATH);
}
