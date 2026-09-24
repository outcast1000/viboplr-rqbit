const { test } = require("node:test");
const assert = require("node:assert");
const { loadPlugin } = require("./harness/sandbox.js");

const plugin = loadPlugin();

test("buildDownloadArgs: global flags precede the subcommand", () => {
  const args = plugin._buildDownloadArgs({ source: "magnet:?xt=urn:btih:" + "a".repeat(40), outDir: "/music" });
  const dl = args.indexOf("download");
  assert.ok(dl > 0, "download subcommand present");
  // rqbit rejects a global flag placed after the subcommand (clap error, exit 2).
  for (const flag of ["-v", "--disable-dht-persistence", "--disable-upnp-port-forward"]) {
    assert.ok(args.indexOf(flag) < dl, flag + " must come before 'download'");
  }
  assert.equal(args[args.indexOf("-v") + 1], "info", "-l listing and progress lines are info-level");
});

test("buildDownloadArgs: one-shot flags, output dir, source last", () => {
  const args = plugin._buildDownloadArgs({ source: "https://x/y.torrent", outDir: "/music" });
  assert.ok(args.includes("-e"), "exit on finish, or rqbit seeds forever");
  assert.ok(args.includes("--disable-http-api"), "download otherwise opens an ephemeral HTTP port");
  assert.equal(args[args.indexOf("-o") + 1], "/music");
  assert.equal(args[args.length - 1], "https://x/y.torrent");
  assert.ok(!args.includes("-r"), "no filter unless asked");
  assert.ok(!args.includes("--overwrite"));
});

test("buildDownloadArgs: filenameRe and overwrite are passed through", () => {
  const args = plugin._buildDownloadArgs({ source: "s", outDir: "/m", filenameRe: plugin._AUDIO_FILE_RE, overwrite: true });
  assert.equal(args[args.indexOf("-r") + 1], plugin._AUDIO_FILE_RE);
  assert.ok(args.includes("--overwrite"));
});

test("buildListArgs: -l with the same global flags", () => {
  const args = plugin._buildListArgs("magnet:?xt=urn:btih:" + "b".repeat(40));
  assert.ok(args.includes("-l"));
  assert.ok(!args.includes("-e"));
  assert.ok(!args.includes("-o"));
  assert.ok(args.indexOf("-v") < args.indexOf("download"));
});

test("AUDIO_FILE_RE matches music extensions case-insensitively when rqbit applies it", () => {
  // rqbit compiles the regex itself; we only assert the pattern's own behaviour.
  const re = new RegExp(plugin._AUDIO_FILE_RE, "i");
  for (const f of ["01 - Song.mp3", "a.flac", "b.m4a", "c.opus", "d.ogg", "e.wav", "f.aiff", "g.aif", "h.ape", "i.wv", "j.dsf"]) {
    assert.ok(re.test(f), f + " should match");
  }
  for (const f of ["cover.jpg", "album.nfo", "sample.mkv", "readme.txt", "a.mp3.part"]) {
    assert.ok(!re.test(f), f + " should not match");
  }
});

test("parseRqbitVersion", () => {
  assert.equal(plugin._parseRqbitVersion("rqbit 9.0.1\n"), "9.0.1");
  assert.equal(plugin._parseRqbitVersion("rqbit 10.2.0-beta.1"), "10.2.0-beta.1");
  assert.equal(plugin._parseRqbitVersion("something else"), null);
  assert.equal(plugin._parseRqbitVersion(""), null);
});
