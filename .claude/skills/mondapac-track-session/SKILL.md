---
name: mondapac-track-session
description: Use at the start and at the end of every working session on the MondaPac Marketplace Platform, and before a session touches a shared file, takes an ADR number or hands a branch to the owner, so the parallel work tracks (backend, frontend, design, product) stay out of each other's way.
---

# MondaPac track session

MondaPac is built in parallel work tracks: one session per track, each with its own
branch and its own clone folder. The rules are in `docs/process/parallel-tracks.md`
(CLAUDE.md rule 13).

Sessions cannot see each other. The Project doc `claude/tracks.md` (the board) is their
only shared memory, so a session that skips it works on stale assumptions. The owner is
the only one who can push, merge, approve gates and run Docker, so everything a session
needs from the owner goes into one ordered queue on the board.

## Start of a session

1. **Know your track.** If the owner did not say which track this session is, ask.
   Tracks: `backend`, `frontend`, `design`, `product`, `coordination`.
2. **Read the board** (`claude/tracks.md`) and your track's status doc in the Project.
3. **Check the folder.** The connected folder must be your track's folder as listed on
   the board. If it is another track's folder, do not write or check out there; tell the
   owner which folder to connect.
4. **Check git, read-only.** From a Cowork device shell use
   `git --no-optional-locks status -sb` and
   `git --no-optional-locks log --oneline -5 --all --decorate`; a plain `git status` can
   leave a lock file that the session cannot delete. If `origin/main` in the folder is
   behind the commit the board names, ask the owner to run `git fetch --prune` before you
   cut a branch.
5. **Reconcile.** If the board and git disagree (a merged branch still listed as waiting,
   a branch the board does not know), fix your own row first, and close the items in the
   owner queue that the owner has since done.
6. **Tell the owner**, in Persian, in a few lines: track, branch, what this session will
   do, and what it is waiting for.

## During the session

- **Stay in your track's paths** (table in `docs/process/parallel-tracks.md`). Reading is
  free everywhere.
- **One slice, one branch, one PR.** Cut the branch from the latest `origin/main`.
- **Shared files** (CLAUDE.md, README.md, the playbooks, `.claude/`,
  `docs/modules/README.md`, `docs/process/skills-map.md`, root tooling and lockfile, CI,
  compose, `.env.example`, migration order, and any path no track owns): record the file
  on the board as held by your track before you edit it, and change it in a small PR of
  its own. If another track holds it, wait for that PR to merge. The two exceptions are
  listed in `docs/process/parallel-tracks.md`.
- **ADR numbers:** reserve the next free number on the board before writing the ADR.
- **Work that belongs to another track:** write it under "requests between tracks" on the
  board. Do not do it yourself.
- **Owner decisions:** ask one at a time with AskUserQuestion, recommended option first.

## End of a session

1. **Hand over the branch** following `mondapac-repo-doc-change`: bring it up to date
   with the latest `main`, run `pnpm verify` for code changes, do not push.
2. **Update the board.** It has no patch operation and no locking. Read it again
   immediately before writing, change only your own row and your own items in the owner
   queue (new items carry the date they were opened), raise the `revision` number by
   one, and write the whole document back. Then read it once more: if your row is
   missing or the revision is not the one you wrote, another session wrote in between,
   so merge and write again.
3. **Update your track's status doc** the same way.
4. **Report to the owner** in Persian, addressing them as «صاحب پروژه»: what changed, the
   branch and commits, the exact push commands, the merge order if several branches are
   waiting, and the open items.
