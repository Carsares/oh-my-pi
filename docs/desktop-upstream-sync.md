# Desktop upstream synchronization

The product repository keeps OMP at the repository root and imports Picot under
`apps/desktop` as a non-squashed Git subtree.

## Remotes

```text
origin          git@github.com:Carsares/oh-my-pi.git
omp-upstream    git@github.com:can1357/oh-my-pi.git
picot-upstream  git@github.com:shixin-guo/picot.git
```

Configure upstream remotes as fetch-only and disable automatic tag fetching.
OMP and Picot use the same global Git tag namespace, while product desktop
releases use `desktop-v<version>` tags.

```bash
git remote add omp-upstream git@github.com:can1357/oh-my-pi.git
git remote add picot-upstream git@github.com:shixin-guo/picot.git
git remote set-url --push omp-upstream DISABLED
git remote set-url --push picot-upstream DISABLED
git config remote.omp-upstream.tagOpt --no-tags
git config remote.picot-upstream.tagOpt --no-tags
```

## Sync OMP

OMP remains at the repository root, so normal Git operations preserve its
history and paths:

```bash
git fetch --no-tags omp-upstream main
git merge --no-ff omp-upstream/main
```

An isolated OMP commit can be cherry-picked directly after reviewing its
dependencies and tests.

## Sync Picot

Pull complete Picot updates through Git subtree so upstream root paths are
mapped into `apps/desktop`:

```bash
git subtree pull --prefix=apps/desktop picot-upstream main
```

Never merge `picot-upstream/main` or cherry-pick a Picot commit directly onto
the product branch. Those operations target the repository root and can
overwrite OMP files with the same names.

For a selective Picot feature, create a temporary Picot-only branch from the
last `git-subtree-split` commit, cherry-pick the reviewed feature commits onto
that branch, and import it with:

```bash
git subtree merge --prefix=apps/desktop <temporary-picot-branch>
```

The subtree merge commits are the source of truth for the last imported Picot
revision. Inspect them with:

```bash
git log --grep='git-subtree-dir: apps/desktop' --format=fuller
```
