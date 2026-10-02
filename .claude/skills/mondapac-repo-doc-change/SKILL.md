---
name: mondapac-repo-doc-change
description: Use when changing any file in the MondaPac Marketplace Platform repo (ADRs, feature docs, CLAUDE.md, agents, playbooks), so edits, branches and commits follow the project's conventions.
---

# MondaPac repo doc change

Work runs in parallel tracks, each with its own clone folder
(`docs/process/parallel-tracks.md`, CLAUDE.md rule 13). Other sessions work at the same
time, and a session can still be connected to a folder that is not its own track's.

## Before editing
1. Read the board, the Project doc `claude/tracks.md`: which track holds which branch,
   which shared files are held, and which ADR numbers are reserved.
2. Run `git status -sb` and `git log --oneline -5 --all --decorate`.
   - From a Cowork device shell add `--no-optional-locks` (`git --no-optional-locks status -sb`); a plain `git status` there can leave a lock file the session cannot delete.
   - Note the current branch and any branch another session is using. The board and the Project docs `claude/*-status.md` record this.
3. Check out a branch only in your own track's folder. In any other folder never switch
   the working tree and do not add a worktree (it writes into that folder's `.git`);
   commit in your own workspace instead and hand the branch over with a git bundle (see
   Committing).
   - Cut the branch from the latest `origin/main`. Stack it on unmerged work only when it depends on that work; ask the owner if unclear.
4. Read the files you will change in full.
   - Reserve the next free ADR number on the board before writing an ADR. 0011 is reserved for the CMS product choice.
   - Before changing a shared file (list in `docs/process/parallel-tracks.md`), record it on the board as held by your track and keep that change in a small PR of its own.

## Editing rules
- **Line endings:** `.gitattributes` stores every text file with LF; older Markdown files
  can still be CRLF in the owner's Windows working tree.
  - Edit with a Python read-modify-write that detects and preserves `\r\n`.
  - Assert each old string matches exactly once.
  - Never re-type a file from tool output.
- **Language:** code, ADRs, commit messages and agent files are in English. Feature docs, playbooks and owner-facing docs are in Persian. IDs and technical terms stay in English.
- **ADRs:** never silently contradict an accepted ADR. Write an amending ADR and add an "Amended by" line to the old one.
- **Hard rules:** when a decision changes a hard rule, update `CLAUDE.md` in the same change.
- **Owner decisions:** record the date and "owner decision" in the ADR status.

## Committing
- **Identity:** if git has no identity configured, commit with `git -c user.name="Mondapac" -c user.email="mondapac@gmail.com" commit`.
- **Message:**
  - Use Conventional Commits (`docs(adr):`, `docs(catalog):`, `chore(team):`, `docs(process):`, …).
  - Write a body that says what changed and why.
  - End with the session's attribution lines.
- **Outputs folder:** never commit the `Claude outputs/` folder; it is gitignored. Check `git status --short` first.
- **Stale lock:** if a stale `.git/index.lock` cannot be deleted, ask for delete permission on the folder, naming only that lock file.
- **Bundles:** when the commits were made outside the owner's folder, hand them over as a git bundle with a new file name each time (a bundle re-sent under the same name can arrive stale). `*.bundle` is gitignored. Give the owner `git bundle verify "<bundle>"`, then `git fetch "<bundle>" <branch>:<branch>` (or `git pull --ff-only "<bundle>" <branch>` if that branch is checked out), then `git push -u origin <branch>`.
- **Pushing:** do not push. The owner pushes and merges. Report the branch, the commit hashes and the merge order of stacked branches.

## After committing
- Update your row on the board `claude/tracks.md` and the Project status doc of your track (`claude/phase-<n>-status.md`, `claude/design-status.md`, …). They have no patch operation: read the doc again right before writing, merge your change in, write it back in full.
- Reply to the owner in Persian and call them «صاحب پروژه». Say what changed, the branch and commit, what is not yet pushed, and the open items.
