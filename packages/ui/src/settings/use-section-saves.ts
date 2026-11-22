'use client';

import { useRef, useState } from 'react';

/**
 * What one section's save did. `stopped` ends the run: the user cancelled a step-up, or the
 * session ended and the page is leaving. The sections after it are not sent.
 */
export type SectionResult = 'saved' | 'failed' | 'stopped';

/** One part of a page that saves through its own endpoint, under the page's one save bar. */
export interface SaveSection {
  readonly key: string;
  /** The section has edits not yet saved. */
  readonly dirty: boolean;
  /** Sends this section's edits. It shows its own refusal; it never throws. */
  readonly save: () => Promise<SectionResult>;
}

export interface SectionRun {
  readonly saved: readonly string[];
  readonly failed: readonly string[];
  /** A section stopped the run; the sections after it were not sent. */
  readonly stopped: boolean;
}

export interface SectionSaves {
  /** Sections with edits: the save bar's count and the leave prompt's count. */
  readonly count: number;
  readonly saving: boolean;
  /**
   * Saves every dirty section in the order given, one after another. A failed section keeps its
   * edits and the others still save, so the result can be partial; a stopped section ends the run.
   * A second call while a run is going returns null and sends nothing.
   */
  readonly saveAll: () => Promise<SectionRun | null>;
}

/**
 * One save bar over several sections that each save through their own endpoint (a page whose
 * parts are separate API resources). The sections keep their own drafts, checks and messages;
 * this hook only counts them and runs their saves in turn.
 */
export function useSectionSaves(sections: readonly SaveSection[]): SectionSaves {
  const [saving, setSaving] = useState(false);
  const running = useRef(false);
  const count = sections.filter((section) => section.dirty).length;

  async function saveAll(): Promise<SectionRun | null> {
    if (running.current) return null;
    running.current = true;
    setSaving(true);
    const saved: string[] = [];
    const failed: string[] = [];
    let stopped = false;
    try {
      for (const section of sections) {
        if (!section.dirty) continue;
        const result = await section.save();
        if (result === 'saved') saved.push(section.key);
        else if (result === 'failed') failed.push(section.key);
        else {
          stopped = true;
          break;
        }
      }
    } finally {
      running.current = false;
      setSaving(false);
    }
    return { saved, failed, stopped };
  }

  return { count, saving, saveAll };
}
