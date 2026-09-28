# Changelog

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
