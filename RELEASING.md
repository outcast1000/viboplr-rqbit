# Releasing & publishing

This plugin ships as a GitHub release containing `rqbit.zip` (with `manifest.json` at the
**zip root**) and `update.json`. The app installs/updates from the `updateUrl` in `manifest.json`.

## Cut a release

1. Bump the version and stamp a changelog section:
   ```bash
   scripts/bump.sh patch      # or minor | major | X.Y.Z
   ```
   Edit `CHANGELOG.md` to replace the TODO with real notes.

2. Commit and tag — **push `main` before or with the tag**; a tag pushed against a stale `main`
   has started a downgrade release before:
   ```bash
   git add manifest.json CHANGELOG.md index.js
   git commit -m "Release vX.Y.Z"
   git tag vX.Y.Z
   git push origin main vX.Y.Z
   ```

3. The **Release** workflow (`.github/workflows/release.yml`) runs on the tag: tests, verifies
   `manifest.json` version == tag, builds `rqbit.zip` + `update.json` via `scripts/package.sh`,
   verifies the zip has `manifest.json` at its root, and publishes the release.

   Do **not** `gh release create` by hand — CI is the only publisher (see `scripts/package.sh`).

The permanent manifest endpoint is:
`https://github.com/outcast1000/viboplr-rqbit/releases/latest/download/update.json`

## First-time GitHub setup

```bash
git init -b main && git add -A && git commit -m "Scaffold viboplr-rqbit"
gh repo create outcast1000/viboplr-rqbit --public --source . --remote origin --push
```

## Registering in the plugin gallery

The gallery (`outcast1000/viboplr-plugins`) is index-only. After the first release exists **and
the host release carrying the `rqbit` dependency entry is out**, add to its `index.json` under
`plugins[]`:

```json
{
  "id": "rqbit",
  "name": "rqbit",
  "author": "Viboplr",
  "description": "Download music over BitTorrent with no torrent client to set up — rqbit fetches magnet links straight into a collection",
  "stability": "experimental",
  "updateUrl": "https://github.com/outcast1000/viboplr-rqbit/releases/latest/download/update.json"
}
```

`version` / `minAppVersion` are synced by the gallery's reconcile bot — omit them. Leave
`recommended` off until the host cancel handle exists (README → Host requirements).
