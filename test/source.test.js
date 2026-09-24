const { test } = require("node:test");
const assert = require("node:assert");
const { loadPlugin } = require("./harness/sandbox.js");

const plugin = loadPlugin();
const HASH = "437aa30064c7eda95dbc3dc6d2da231adc12a9b0";

test("isTorrentSource: magnets need a real infohash", () => {
  assert.ok(plugin._isTorrentSource("magnet:?xt=urn:btih:" + HASH));
  assert.ok(plugin._isTorrentSource("  magnet:?xt=urn:btih:" + HASH.toUpperCase() + "&dn=x  "));
  assert.ok(!plugin._isTorrentSource("magnet:?dn=nohash"));
  assert.ok(!plugin._isTorrentSource("magnet:?xt=urn:btih:tooshort"));
});

test("isTorrentSource: URLs and .torrent paths", () => {
  assert.ok(plugin._isTorrentSource("https://example.org/dl/album.torrent"));
  assert.ok(plugin._isTorrentSource("http://tracker/download.php?id=1"), "a tracker download link need not end in .torrent");
  assert.ok(plugin._isTorrentSource("/Users/alex/Downloads/album.torrent"));
  assert.ok(!plugin._isTorrentSource("/Users/alex/Downloads/album.zip"));
  assert.ok(!plugin._isTorrentSource("just some words"));
  assert.ok(!plugin._isTorrentSource(""));
  assert.ok(!plugin._isTorrentSource(null));
});

test("infoHashOf", () => {
  assert.equal(plugin._infoHashOf("magnet:?xt=urn:btih:" + HASH.toUpperCase()), HASH);
  assert.equal(plugin._infoHashOf("https://x/y.torrent"), null);
});

test("sourceDisplayName: dn wins, then URL basename, then a short hash", () => {
  assert.equal(plugin._sourceDisplayName("magnet:?xt=urn:btih:" + HASH + "&dn=Artist+-+Album%20%5B2020%5D"), "Artist - Album [2020]");
  assert.equal(plugin._sourceDisplayName("magnet:?xt=urn:btih:" + HASH), "magnet 437aa300…");
  assert.equal(plugin._sourceDisplayName("https://example.org/dl/Some%20Album.torrent?key=1"), "Some Album.torrent");
  assert.equal(plugin._sourceDisplayName("/Users/alex/Downloads/album.torrent"), "album.torrent");
});
