---
name: mondapac-repo-doc-change
description: Use when changing any file in the MondaPac Marketplace Platform repo (ADRs, feature docs, CLAUDE.md, agents, playbooks), so edits, branches and commits follow the project's conventions.
---

# MondaPac repo doc change

Other sessions may be working in the same repo folder at the same time.

## Before editing
1. Run `git status -sb` and `git log --oneline -5 --all --decorate`.
   - Note the current branch and any branch another session is using. The Project docs `claude/phase-*-status.md` record this.
2. Never switch the shared working tree away from a branch another session uses. Prefer a worktree outside the shared folder:
   `git worktree add -b <type>/<topic> "$HOME/wt-<topic>" <base-branch>`
   - Stack the new branch on the latest unmerged work; ask the owner if unclear.
   - Remove the worktree when done.
3. Read the files you will change in full.
   - Check `docs/adr/` for the next free ADR number. 0011 is reserved for the CMS product choice.

## Editing rules
- **Line endings:** files use CRLF on the owner's Windows machine.
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
- **Pushing:** do not push. The owner pushes and merges. Report the branch, the commit hashes and the merge order of stacked branches.

## After committing
- Update the Project status doc `claude/phase-<n>-status.md`. It has no patch operation: read it, merge your change in, write it back in full.
- Reply to the owner in Persian and call them «صاحب پروژه». Say what changed, the branch and commit, what is not yet pushed, and the open items.
