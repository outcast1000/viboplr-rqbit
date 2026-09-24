# viboplr-rqbit

Download music over BitTorrent from inside [Viboplr](https://viboplr.com) with **no torrent
client to install or configure**. Paste a magnet link or a `.torrent` URL; [rqbit](https://github.com/ikatson/rqbit)
fetches it straight into one of your collections and the library rescans itself.

Every download is a **one-shot process**: `rqbit download --exit-on-finish` starts, downloads,
exits. Nothing runs in the background between downloads, nothing seeds afterwards, there is no
daemon, no WebUI and no API key.

> **Status: scaffold (0.1.0).** The download flow, output parsing and view are implemented and
> unit-tested against rqbit 9.0.1's real output, but the plugin cannot run against a released
> Viboplr yet — see [Host requirements](#host-requirements).

## How it differs from viboplr-qbittorrent

| | rqbit (this plugin) | qBittorrent plugin |
|---|---|---|
| Setup | none — Viboplr installs the binary | install qBittorrent 5.2.3+, enable the WebUI, create an API key |
| Runs | one process per download, exits when done | a resident client you manage |
| Seeding / ratio | none — the process exits at 100% | yes |
| Resume after quitting the app | no (start it again; `--overwrite` rehashes what's there) | yes |
| Torrent list, pause, per-file pick | no (the "Audio files only" filter instead) | yes |
| Play while downloading | no | yes (sequential + stream) |

They are deliberately **two plugins, not one with two engines**: the shapes share almost nothing,
and a common abstraction would have flattened both toward the weaker one. If you use a private
tracker, you want the qBittorrent one.

## Usage

1. **Settings → Dependencies**: install rqbit (Viboplr downloads the official build).
2. **Settings → rqbit**: choose the destination collection; leave *Audio files only* on unless
   you want cover scans and `.nfo` files too.
3. **Torrents** (sidebar): paste a magnet link or `.torrent` URL and press *Download*. The row
   shows peers, speed, ETA and a progress bar; when it finishes the collection is rescanned and
   the album appears in your library.

Files land in `<collection>/<torrent name>/`.

## Host requirements

Three host additions carry this plugin. All three are implemented in the Viboplr repo (on
worktree-2, unreleased at the time of writing); `minAppVersion` in `manifest.json` names the first
release that ships them. Each is feature-detected, so the plugin degrades rather than breaks on
an older build:

1. **`rqbit` in the dependency registry** (`src-tauri/src/dependencies.rs`) — `--version` →
   `rqbit X.Y.Z`, managed install from `ikatson/rqbit` (`rqbit-osx-universal` /
   `rqbit-linux-amd64` / `rqbit-linux-arm64` / `rqbit.exe`; no checksums file upstream, so the
   install is TLS-only verified). The registry **is** the `api.system.exec` allow-list. Without
   it nothing runs: the settings panel says so.
2. **`opts.onStart(handle)` on `api.system.exec`** — a `{ cancel() }` handle for a long run
   started outside a download resolve, where there is no host Cancel button. This is what the
   row's *Cancel* button and `deactivate()` use. Without it there is no Cancel, and a magnet with
   no peers — which hangs rqbit **forever, silently** — runs until the app quits; the view says
   so after 90s.
3. **`api.collections.trashPath(collectionId, relativePath)`** — trash something the plugin put
   inside a local collection, with the root / `..` / symlink checks in Rust. rqbit preallocates
   every file to full size before the first byte arrives, so a failed or cancelled run leaves
   files that look complete and would be scanned in as music; the plugin trashes
   `<collection>/<torrent name>` on failure/cancel (never when rqbit refused to start because
   the files already existed — those are the user's). Without it, the view warns and offers
   *Open folder*.

## rqbit CLI facts

Verified against rqbit **9.0.1** (2026-09-24). The parsers in `index.js` and the fixtures in
`test/output.test.js` depend on these.

- Global flags go **before** the subcommand: `rqbit -v info --disable-dht-persistence download …`.
  After it they are a clap error (exit 2).
- **Everything goes to stdout** — logs, progress, `-l` listing — one `tracing` line each, ANSI
  coloured unless `NO_COLOR=1`. stderr is empty. The listing only prints at `-v info`.
- Progress, once per second:
  `INFO rqbit: [0]: 33.55% (8.00Mi / 23.84Mi), ↓1.91 MiB/s, ↑0.00 MiB/s (0), ETA: 8.286s, {live: 1, queued: 0, dead: 0, known: 1}`
  (`ETA` absent at zero speed). **Nothing prints while waiting for magnet metadata.**
- `-e` ends with `INFO rqbit: All downloads completed, exiting`, exit 0. Output is `<out>/<name>/`.
- `-r <regex>` matches the **basename**; no match → exit 1, `none of the filenames match`.
  Unselected files are still created (small ones in full, others as piece spill).
- **Files are fully preallocated**, not sparse.
- SIGTERM → `error running rqbit: cancelled`, exit 1 (5s grace, then it self-kills).
- Existing file without `--overwrite` → exit 1 `File exists`; with it, rqbit rehashes and finishes.
- `--disable-dht-persistence` is needed for two concurrent downloads (shared DHT state file);
  `--disable-http-api` because `download` otherwise opens an ephemeral HTTP port.

## Development

```bash
node --check index.js
node --test
scripts/package.sh        # build rqbit.zip + update.json locally
```

The plugin is plain ES5 run through `new Function("api", code)`; `test/harness/sandbox.js`
loads it the same way with the host's missing globals shadowed as throwing bindings, and
`test/harness/mock-api.js` fakes the host bridge so `test/integration.test.js` can drive a whole
download through captured rqbit output. See `RELEASING.md` to cut a release.

## Roadmap

- **Find torrents…** — port the web-indexer search from viboplr-qbittorrent (its
  `WEB_DEFS` + `webSearchAll` block is client-agnostic), contributing the context-menu items.
- **Per-file pick** via `rqbit download -l` before starting (the parser exists: `parseListOutput`).
- **Assistant tools** (`status`, `download`) once the host cancel handle exists — an assistant
  must never be able to start something nobody can stop.
- **Concurrency cap** — downloads currently run in parallel; two at once already works, but a
  paste-happy session could open many processes.
