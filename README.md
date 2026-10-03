# viboplr-rqbit

Find and download music over BitTorrent from inside [Viboplr](https://viboplr.com) with **no
torrent client to install or configure**. Search torrent sites or paste a magnet link; take a
whole album into one of your collections, or pick single tracks and download them through
Viboplr's download window. [rqbit](https://github.com/ikatson/rqbit) does the transfer.

Every download is a **one-shot process**: `rqbit download --exit-on-finish` starts, downloads,
exits. Nothing runs in the background between downloads, nothing seeds afterwards, there is no
daemon, no WebUI and no API key.

> **Status: experimental (0.3.0), not yet live-tested.** Every flow is unit-tested against rqbit
> 9.0.1's captured output and saved indexer pages, but has not been run end to end in the app.

## How it differs from viboplr-qbittorrent

| | rqbit (this plugin) | qBittorrent plugin |
|---|---|---|
| Setup | none — Viboplr installs the binary | install qBittorrent 5.2.3+, enable the WebUI, create an API key |
| Runs | one process per download, exits when done | a resident client you manage |
| Seeding / ratio | none — the process exits at 100% | yes |
| Resume after quitting the app | no (start it again; `--overwrite` rehashes what's there) | yes |
| Torrent list, pause | no | yes |
| Per-file pick | yes — *Pick tracks…*, through the download window | yes |
| Torrent search | the bundled web indexers | the same, plus qBittorrent's own search plugins |
| Play while downloading | no | yes (sequential + stream) |

They are deliberately **two plugins, not one with two engines**: the shapes share almost nothing,
and a common abstraction would have flattened both toward the weaker one. If you use a private
tracker, you want the qBittorrent one.

## Usage

1. **Settings → Dependencies**: install rqbit (Viboplr downloads the official build).
2. **Settings → rqbit**: choose the destination collection for whole-torrent downloads; leave
   *Audio files only* on unless you want cover scans and `.nfo` files too. Turn off any search
   site that is blocked on your network.
3. **Torrents** (sidebar) — one box for both:
   - **Paste a magnet link or `.torrent` URL** → it downloads into `<collection>/<torrent name>/`
     and the collection is rescanned. Progress (peers, speed, ETA) is on the *Downloads* tab.
   - **Type an artist or album** → the search sites are asked and the results come back as a
     sortable table. *Download* takes the whole torrent as above; the result's name (or
     *Pick tracks…*) lists its files, and *Download…* on a file opens Viboplr's download window
     for just that file — you choose where it goes, watch it, and can cancel.
4. **Right-click** a track, album or artist anywhere:
   - **rqbit: Find torrents…** opens the view already searching *artist + album*.
   - **rqbit: Download…** (tracks) opens the download window, which then searches the sites,
     checks up to three likely torrents for the track and fetches only that file.
5. To make rqbit the downloader for tracks with no source yet (a detail page's
   "Not in library" rows), move **rqbit (download only)** up in Settings → Providers. That
   entry never plays anything — it answers every play with "no" at once — it only decides who
   downloads.

### How a single track is downloaded

The download window's resolve *is* the download (as with yt-dlp): rqbit runs with
`-r '^<exact file name>$'` into a fresh folder in the plugin's storage, the resolve answers with
the file's `file://` path, and the window copies it to the destination. The file's own tags
fill in the metadata. Temp folders are swept before the next download (the last three are kept
while the window may still be copying) and wiped when the plugin starts. A download that gets no
peers in 90s, or no new data for 3 minutes, is stopped with a reason; a file listing gives up
after 45s.
## Host requirements

`minAppVersion` is **1.0.73**: the menu items use bare labels (*Find torrents…*, *Download…*),
which that version prefixes with the plugin name. Everything else is feature-detected:

1. **`rqbit` in the dependency registry** (`src-tauri/src/dependencies.rs`, since 1.0.71) — the
   registry **is** the `api.system.exec` allow-list. Without it nothing runs.
2. **`opts.onStart(handle)` on `api.system.exec`** (1.0.71) — the job row's *Cancel*, stopping
   a dead file listing, and the provider's no-peers / stall stops. Without it a magnet with no
   peers runs until the app quits.
3. **`api.collections.trashPath`** (1.0.71) — rqbit preallocates every file to full size, so a
   failed whole-torrent job trashes `<collection>/<torrent name>` (never when rqbit refused to
   start because the files already existed). Without it, the view warns and offers *Open folder*.
4. **`api.downloads.*` + `api.storage.files` + `api.ui.requestAction("download-tracks")`** — the
   single-track path. `reportProgress` and `readAudioTags` are optional extras.

A host fix that makes the provider's *Cancel* airtight landed with this release (Viboplr
`usePlugins.ts`): a cancelled resolve now refuses new execs. Before it, cancelling while a
search-for-a-track was *between* steps (searching sites, say) let the next rqbit run start and
finish unobserved.

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

**Assumed, not yet verified against the binary** (the code is written to survive either answer):

- How `-l` names a file in a multi-folder torrent (`CD1/01.flac` or `01.flac`). The provider
  downloads by basename (`-r`) and then *walks* its temp folder for the file, preferring the copy
  whose path ends with the listed one, so it doesn't depend on the answer.
- Whether `-l` prints the `added torrent name=` line. The view and the hunt fall back to the
  search result's name.

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

- **Assistant tools** (`status`, `search`, `download`) — the cancel handle now exists, so an
  assistant-started download can be stopped.
- **Concurrency cap** — downloads run in parallel; two at once works, but a paste-happy session
  (or a 20-track multi-download) opens that many processes.
- **Custom search sites** — the definition validator is ported (`validateIndexerDef`); the
  settings paste box from viboplr-qbittorrent is not.
