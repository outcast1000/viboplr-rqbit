# Changelog

## v0.3.0
- **Search.** The Torrents view's box now searches torrent sites (The Pirate Bay, Nyaa, 1337x,
  BitSearch, RARGB — the qBittorrent plugin's web indexers, ported) when what you type isn't a
  magnet link. Results are a sortable table (size, seeders, leechers, age, site); a site that
  fails is named under the results. Each site can be turned off in Settings → rqbit.
- **Pick tracks.** Open a result to see its files (rqbit asks the swarm for the list) and
  download only the ones you want through Viboplr's download window — destination, live
  progress and a Cancel that stops rqbit. *Download* still takes the whole torrent into your
  destination collection, and the Search / Downloads tabs keep the two apart.
- **rqbit is a download provider.** Right-click a track → *rqbit: Download…* finds a torrent
  that has it, picks the file and fetches just that file, all inside the download window.
  *rqbit: Find torrents…* on a track, album or artist opens the view already searching.
- **"rqbit (download only)"** appears in Settings → Providers. It never plays anything; moving
  it up is how you make rqbit the downloader for tracks with no source (a detail page's
  "Not in library" rows).
- Requires Viboplr 1.0.73 (the menu items use bare labels, which that version prefixes with
  the plugin name).

## v0.2.0
- Uses the host-drawn view header (Viboplr 1.0.77+): the Torrents view's header shows the rqbit
  version, the destination collection and how many downloads are running, with a one-word
  status (Ready / Downloading / Not installed / No destination / Update Viboplr) and an
  **Open folder** button for the destination. Problems and their fix stay in the view's banner.
  Older hosts are unaffected (feature-detected; no `minAppVersion` change).

## v0.1.0
- Initial scaffold: paste a magnet / `.torrent` URL, one-shot `rqbit download` into a chosen
  collection, live progress (peers, speed, ETA), automatic rescan on completion, audio-only
  filter, settings panel with dependency status. Output parsers pinned against rqbit 9.0.1.
- Not installable on a released Viboplr yet — needs the `rqbit` dependency-registry entry
  (see README → Host requirements).
