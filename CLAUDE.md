# Báscula Central: working rules

## Two repositories

| Remote | Repository | What it holds |
|---|---|---|
| `origin` (**public**) | `Elvis-techh/weight_software` | Only work that is ready to ship. It reaches `main` through a pull request. |
| `respaldo` (**private**) | `Elvis-techh/weight_software-respaldo` | A backup of every local branch, finished or not. Actions are disabled. It never gets tags. |

Unfinished work stays off `origin`. Anything pushed to a public repository can't be taken back.

`git respaldo` (alias for `git push respaldo --all`) backs up **committed** work only.
Uncommitted changes, untracked files and ignored files (`.env`, `backend/sandbox/`) are not in it.

## What the two requests mean

If it isn't clear which one applies, ask. The default is that nothing goes to `origin`.

### "These changes are going to weight_software"

This allows: branch, commit, push that branch to `origin`, open a PR into `main`.
It does **not** allow merging the PR, deploying or tagging. Each of those needs its own request.

1. Start from an up-to-date `main`: `git switch main && git pull`, then `git switch -c <descriptive-name>`. One topic per branch.
2. If the changes already exist elsewhere, move only those: `git stash` for uncommitted work, `git cherry-pick` for commits. Never open a PR from a branch that came from unfinished work.
3. If the change depends on unfinished code, it can't ship alone. Say so and stop.
4. Test, commit, then check `git diff --stat main...HEAD`: only the files for this topic.
5. `git push -u origin <branch>` and open the PR. Run `git respaldo`.

After the user says the PR is merged:

1. `git switch main && git pull`
2. In **each** unfinished branch: `git merge main` (merge, never rebase: these branches are already in the backup). Run the tests (`cd backend && npm test`, where the branch has them).
3. `git respaldo`

### "These changes are unfinished. Move them to weight_software-respaldo"

This allows: commit on the right local branch, then `git respaldo`. Nothing goes to `origin`.

1. Pick the branch. Work that belongs to an existing unfinished branch goes there. New work that needs unfinished code starts from that branch. Any other new work starts from `main`.
2. Commit. A "WIP:" message is fine for half-done work.
3. `git respaldo`, then confirm with `git ls-remote respaldo` that the commit arrived.

At the end of a work session, if there is uncommitted work, say so. It is not backed up.

## Unfinished branches

- `inicio-de-sesion`: sign-in and roles. First commit `4192831`.

Keep this list current.

## Guard on `origin`

`.git/hooks/pre-push` refuses, for `origin` only:

- any push that contains commit `4192831` (the sign-in work);
- any `v*` tag, unless run as `ALLOW_RELEASE=1 git push origin vX.Y.Z`.

Use `ALLOW_RELEASE=1` only when the user asks for a release. Never bypass the hook with `--no-verify`.

The guard knows **only** about the sign-in work. Other unfinished branches are protected by these rules alone.

When sign-in is ready to ship, remove the sign-in check from the hook, tell the user, and merge the branch through a normal PR.

## On a new computer

Hooks, aliases and extra remotes are not copied by `git clone`.

1. Clone `weight_software-respaldo`.
2. `git remote rename origin respaldo`
3. `git remote add origin git@github.com:Elvis-techh/weight_software.git`
4. `git config alias.respaldo "push respaldo --all"`
5. Create each other branch locally: `git switch <branch>`.
6. Recreate the executable pre-push hook with the two rules above.

## Production

Never touch real data or the real app while developing. Development, testing, deploy and release steps are in `DESARROLLO.md`. Deploy only after the 7 p.m. shift end.
