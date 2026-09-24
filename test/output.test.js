// Parsers for rqbit's stdout. Every fixture line here was captured from rqbit
// 9.0.1 (NO_COLOR=1 -v info) during the CLI spike — see README → "rqbit CLI facts".
const { test } = require("node:test");
const assert = require("node:assert");
const { loadPlugin } = require("./harness/sandbox.js");

const plugin = loadPlugin();

const PROGRESS = "2026-09-24T06:52:30.102503Z  INFO rqbit: [0]: 25.17% (6.00Mi / 23.84Mi), ↓1.88 MiB/s, ↑0.00 MiB/s (0), ETA: 9.481s, {live: 1, queued: 0, dead: 0, known: 1}";
const PROGRESS_IDLE = "2026-09-24T06:51:38.585844Z  INFO rqbit: [0]: 100.00% (23.84Mi / 23.84Mi), ↓0.00 MiB/s, ↑0.00 MiB/s (0), {live: 0, queued: 0, dead: 0, known: 0}";

test("parseProgressLine: a live line", () => {
  const p = plugin._parseProgressLine(PROGRESS);
  assert.ok(p);
  assert.equal(p.percent, 25.17);
  assert.equal(p.doneBytes, Math.round(6 * 1024 * 1024));
  assert.equal(p.totalBytes, Math.round(23.84 * 1024 * 1024));
  assert.equal(p.downMiBps, 1.88);
  assert.equal(p.upMiBps, 0);
  assert.equal(p.etaSecs, 9.481);
  assert.equal(p.peersLive, 1);
  assert.equal(p.peersKnown, 1);
});

test("parseProgressLine: ETA is absent at zero speed", () => {
  const p = plugin._parseProgressLine(PROGRESS_IDLE);
  assert.ok(p);
  assert.equal(p.percent, 100);
  assert.equal(p.etaSecs, null);
  assert.equal(p.peersLive, 0);
});

test("parseProgressLine: arrows mangled by a terminal still parse", () => {
  // cat -v rendering of the same line: the arrows become byte escapes.
  const mangled = PROGRESS.replace("↓", "�M-^FM-^S").replace("↑", "�M-^FM-^Q");
  const p = plugin._parseProgressLine(mangled);
  assert.ok(p);
  assert.equal(p.downMiBps, 1.88);
});

test("parseProgressLine: other log lines are null", () => {
  for (const l of [
    "2026-09-24T06:52:26.518024Z  INFO rqbit: increased open file limit limit=1048576",
    "2026-09-24T06:52:26.804507Z  INFO rqbit: All downloads completed, exiting",
    "2026-09-24T06:52:26.719379Z  INFO librqbit::session: will download filename=01 - First Song.mp3",
    "",
  ]) {
    assert.equal(plugin._parseProgressLine(l), null, l);
  }
});

test("parseSize: IEC prefixes as rqbit prints them", () => {
  assert.equal(plugin._parseSize("6"), 6);
  assert.equal(plugin._parseSize("19.0Mi"), Math.round(19 * 1024 * 1024));
  assert.equal(plugin._parseSize("4.7Mi"), Math.round(4.7 * 1024 * 1024));
  assert.equal(plugin._parseSize("1.2Gi"), Math.round(1.2 * 1024 * 1024 * 1024));
  assert.equal(plugin._parseSize("512Ki"), 512 * 1024);
  assert.equal(plugin._parseSize("23.84 MiB"), Math.round(23.84 * 1024 * 1024));
  assert.equal(plugin._parseSize("nope"), null);
});

test("parseTorrentName: the folder rqbit creates under the output dir", () => {
  assert.equal(plugin._parseTorrentName('2026-09-24T06:52:26.720204Z  INFO librqbit::session: added torrent name="album"'), "album");
  assert.equal(plugin._parseTorrentName('INFO librqbit::session: added torrent name="Artist - Album (2020) [FLAC]"'), "Artist - Album (2020) [FLAC]");
  assert.equal(plugin._parseTorrentName('INFO librqbit::session: added torrent name="He said \\"hi\\""'), 'He said "hi"');
  assert.equal(plugin._parseTorrentName(PROGRESS), null);
});

test("parseListOutput: -l listing, name split on the LAST ', size '", () => {
  const out = [
    "2026-09-24T06:53:06.748550Z  INFO rqbit: increased open file limit limit=1048576",
    "2026-09-24T06:53:06.949439Z  INFO rqbit: File 01 - First Song.mp3, size 19.0Mi",
    "2026-09-24T06:53:06.949450Z  INFO rqbit: File cover.jpg, size 6",
    "2026-09-24T06:53:06.949451Z  INFO rqbit: File weird, size name.flac, size 4.7Mi",
  ].join("\n");
  const files = plugin._parseListOutput(out);
  assert.deepEqual(files.map((f) => f.name), ["01 - First Song.mp3", "cover.jpg", "weird, size name.flac"]);
  assert.equal(files[0].sizeBytes, Math.round(19 * 1024 * 1024));
  assert.equal(files[1].sizeBytes, 6);
  assert.equal(files[2].sizeText, "4.7Mi");
});

test("parseErrorMessage: the specific 'error adding' reason wins over the generic one", () => {
  const out = [
    '2026-09-24T06:53:07.473462Z ERROR rqbit: error adding "magnet:?xt=urn:btih:437a": none of the filenames match the given regex',
    "2026-09-24T06:53:07.473481Z ERROR rqbit: error running rqbit: no torrents were added",
  ].join("\n");
  assert.equal(plugin._parseErrorMessage(out), "none of the filenames match the given regex");
  assert.equal(plugin._parseErrorMessage("ERROR rqbit: error running rqbit: cancelled"), "cancelled");
  assert.equal(plugin._parseErrorMessage("INFO rqbit: fine"), "");
});

test("classifyOutcome: exit 0 alone is not success — rqbit's completion line is required", () => {
  const ok = plugin._classifyOutcome(0, "INFO rqbit: All downloads completed, exiting\n");
  assert.deepEqual(ok, { ok: true, message: "" });
  // `-l` and a rejected URL both exit 0 without completing anything.
  const notReally = plugin._classifyOutcome(0, 'ERROR rqbit: error adding "x": GET x returned 503 Service Unavailable\n');
  assert.equal(notReally.ok, false);
  assert.match(notReally.message, /could not be fetched \(503 Service Unavailable\)/);
});

test("classifyOutcome: SIGTERM is reported as cancelled, not a failure", () => {
  const c = plugin._classifyOutcome(1, "WARN rqbit: received signal 15, trying to shut down gracefully\nERROR rqbit: error running rqbit: cancelled\n");
  assert.equal(c.ok, false);
  assert.equal(c.cancelled, true);
});

test("classifyOutcome: known failures get a human sentence", () => {
  const noMatch = plugin._classifyOutcome(1, 'ERROR rqbit: error adding "m": none of the filenames match the given regex\n');
  assert.match(noMatch.message, /No audio files in this torrent/);
  const exists = plugin._classifyOutcome(1, 'ERROR rqbit: error adding "m": error creating a new file (because allow_overwrite = false) "outB/album/01.mp3"\n    File exists (os error 17)\n');
  assert.match(exists.message, /already exist/);
  const noPeers = plugin._classifyOutcome(1, 'ERROR rqbit: error adding "m": input address stream exhausted, no way to discover torrent metainfo\n');
  assert.match(noPeers.message, /Could not find any peer/);
  const notTorrent = plugin._classifyOutcome(0, 'ERROR rqbit: error adding "test.torrent": error decoding torrent\n\nCaused by:\n    invalid value\n');
  assert.match(notTorrent.message, /not a valid \.torrent/);
  const unknown = plugin._classifyOutcome(3, "");
  assert.equal(unknown.message, "rqbit exited with code 3");
});

test("formatBytes / formatEta", () => {
  assert.equal(plugin._formatBytes(0), "0 B");
  assert.equal(plugin._formatBytes(2048), "2 KB");
  assert.equal(plugin._formatBytes(25 * 1024 * 1024), "25.0 MB");
  assert.equal(plugin._formatBytes(1.5 * 1024 * 1024 * 1024), "1.50 GB");
  assert.equal(plugin._formatBytes(-1), "");
  assert.equal(plugin._formatEta(9.481), "9s");
  assert.equal(plugin._formatEta(125), "2m 5s");
  assert.equal(plugin._formatEta(3700), "1h 1m");
  assert.equal(plugin._formatEta(null), "");
});

test("jobStatusText: a silent 'starting' job is called stuck after the timeout", () => {
  const t0 = 1000000;
  const job = { state: "starting", startedAt: t0, percent: 0, peersLive: 0 };
  assert.equal(plugin._jobStatusText(job, t0 + 1000), "Finding peers…");
  // 90s timeout + 30s = 2 min, rounded.
  assert.match(plugin._jobStatusText(job, t0 + plugin._STUCK_AFTER_MS + 30000), /No peers found after 2 min/);
});

test("jobStatusText: downloading line carries the figures the user wants", () => {
  const job = { state: "downloading", percent: 25.17, doneBytes: 6 * 1024 * 1024, totalBytes: 24 * 1024 * 1024, downMiBps: 1.88, etaSecs: 9.481, peersLive: 1 };
  assert.equal(plugin._jobStatusText(job), "25.2% · 6.0 MB / 24.0 MB · ↓ 1.88 MiB/s · ETA 9s · 1 peer");
});
