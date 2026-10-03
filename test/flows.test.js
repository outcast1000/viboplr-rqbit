// Search, Pick tracks, the download provider and the hunt — pure helpers plus
// whole flows through the mock host.
const { test } = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");
const { loadPlugin } = require("./harness/sandbox.js");
const { makeApi, fire, callHandler } = require("./harness/mock-api.js");

const plugin = loadPlugin();
const fix = (name) => fs.readFileSync(path.join(__dirname, "fixtures", name), "utf8");

const MAGNET = "magnet:?xt=urn:btih:437aa30064c7eda95dbc3dc6d2da231adc12a9b0&dn=album&tr=udp%3A%2F%2Ft.example%3A1337";

// What `rqbit -v info download -l` prints for a two-file album.
const LISTING = [
  "2026-09-24T06:52:26.518024Z  INFO rqbit: increased open file limit limit=1048576",
  "2026-09-24T06:52:27.100000Z  INFO rqbit: File 01 - First Song.mp3, size 19.0Mi",
  "2026-09-24T06:52:27.100100Z  INFO rqbit: File cover.jpg, size 120Ki",
  "2026-09-24T06:52:27.100200Z  INFO rqbit: File 02 - Second Song.mp3, size 21.5Mi",
];

function runLines(name) {
  return [
    '2026-09-24T06:52:26.720204Z  INFO librqbit::session: added torrent name="album"',
    "2026-09-24T06:52:30.102503Z  INFO rqbit: [0]: 50.00% (4.00Mi / 8.00Mi), ↓1.88 MiB/s, ↑0.00 MiB/s (0), ETA: 2.000s, {live: 3, queued: 0, dead: 0, known: 4}",
    "2026-09-24T06:52:31.103876Z  INFO rqbit: [0]: 100.00% (8.00Mi / 8.00Mi), ↓1.91 MiB/s, ↑0.00 MiB/s (0), {live: 3, queued: 0, dead: 0, known: 4}",
    "2026-09-24T06:52:31.204507Z  INFO rqbit: All downloads completed, exiting",
  ];
}

// An exec rule for a provider download: rqbit "writes" `files` (relative to
// its -o folder) into the mock's plugin storage, then prints a good run.
function fetchRule(holder, relFiles) {
  return {
    match: { cmd: "rqbit", argsInclude: ["-e"] },
    result: (cmd, args) => {
      const out = args[args.indexOf("-o") + 1].replace(/^\/data\//, "");
      for (const f of relFiles) holder.api._files.add(out + "/" + f);
      return { exitCode: 0, lines: runLines() };
    },
  };
}

function lastView(api, id) {
  const rows = api.calls.setViewData.filter((c) => c.id === id);
  return rows[rows.length - 1].data;
}

function findNode(node, pred) {
  if (!node) return null;
  if (pred(node)) return node;
  for (const c of node.children || []) {
    const hit = findNode(c, pred);
    if (hit) return hit;
  }
  return null;
}

function textsIn(node, out) {
  out = out || [];
  if (!node) return out;
  if (node.type === "text") out.push(node.content);
  for (const c of node.children || []) textsIn(c, out);
  return out;
}

async function activated(config) {
  const p = loadPlugin();
  const api = makeApi(config);
  await p.activate(api);
  return { plugin: p, api };
}

// apibay answers; every other site is down.
const apibayOnly = async (url) => (/apibay\.org/.test(url) ? { status: 200, body: fix("apibay-search.json") } : { status: 403, body: "" });
const disabledAllBut = (id) => {
  const out = {};
  for (const d of plugin._WEB_DEFS) if (d.id !== id) out[d.id] = true;
  return out;
};

// --- Pure ---------------------------------------------------------------------

test("titleMatchScore: a title alone never matches; title + artist or album does", () => {
  const want = { title: "Jóga", artist: "Björk", album: "Homogenic" };
  assert.ok(plugin._titleMatchScore({ fileName: "03 - Joga.flac", torrentName: "Bjork - Homogenic [FLAC]" }, want) >= 0.7);
  assert.ok(plugin._titleMatchScore({ fileName: "03 - Joga.flac", torrentName: "Various - Best Of" }, want) < 0.7);
  assert.equal(plugin._titleMatchScore({ fileName: "03 - Hunter.flac", torrentName: "Bjork - Homogenic" }, want), 0);
});

test("pickFileForTrack: audio only, and the bigger copy of an equal match", () => {
  const files = [
    { name: "Homogenic/03 - Joga.mp3", sizeBytes: 9e6 },
    { name: "Homogenic/03 - Joga.flac", sizeBytes: 30e6 },
    { name: "Homogenic/Joga.nfo", sizeBytes: 1e3 },
  ];
  const got = plugin._pickFileForTrack(files, "Bjork - Homogenic", { title: "Joga", artist: "Bjork" });
  assert.equal(got.name, "Homogenic/03 - Joga.flac");
  assert.equal(plugin._pickFileForTrack(files, "Bjork - Homogenic", { title: "Bachelorette", artist: "Bjork" }), null);
});

test("rqbit:// URIs round-trip, magnet ampersands and all", () => {
  const f = plugin._parseRqbitUri(plugin._fileUri(MAGNET, "CD1/01 - A&B.flac"));
  assert.deepEqual(JSON.parse(JSON.stringify(f)), { kind: "file", source: MAGNET, path: "CD1/01 - A&B.flac" });
  const h = plugin._parseRqbitUri(plugin._findUri({ title: "Jóga", artist: "Björk", album: "", durationSecs: 305.4 }));
  assert.deepEqual(JSON.parse(JSON.stringify(h)), { kind: "find", want: { title: "Jóga", artist: "Björk", album: "", durationSecs: 305 } });
  assert.equal(plugin._parseRqbitUri("qbt://abc/1"), null);
  assert.equal(plugin._parseRqbitUri("rqbit://file?src=not-a-source&path=x"), null);
  assert.equal(plugin._parseRqbitUri("rqbit://find?artist=x"), null, "a hunt needs a title");
});

test("exactNameRe escapes every regex metacharacter in a filename", () => {
  assert.equal(plugin._exactNameRe("01 - (Live) [2001] A+B.flac"), "^01 - \\(Live\\) \\[2001\\] A\\+B\\.flac$");
  assert.ok(new RegExp(plugin._exactNameRe("a.b (c).mp3")).test("a.b (c).mp3"));
  assert.ok(!new RegExp(plugin._exactNameRe("a.b (c).mp3")).test("axb (c).mp3"));
});

test("parseReleaseName / parseFileTrack: the modal's first guess at names", () => {
  assert.deepEqual(JSON.parse(JSON.stringify(plugin._parseReleaseName("Bjork - Homogenic (1997) [FLAC]"))), { artist: "Bjork", album: "Homogenic" });
  assert.deepEqual(JSON.parse(JSON.stringify(plugin._parseReleaseName("bjork homogenic"))), { artist: null, album: "bjork homogenic" });
  const t = plugin._parseFileTrack("CD1/03 - Joga.flac");
  assert.equal(t.title, "Joga");
  assert.equal(t.trackNumber, 3);
});

test("searchQueryForTarget: artist + album, a track searches its album", () => {
  assert.equal(plugin._searchQueryForTarget({ kind: "track", title: "Joga", artistName: "Björk", albumTitle: "Homogenic" }), "Björk Homogenic");
  assert.equal(plugin._searchQueryForTarget({ kind: "track", title: "Joga", artistName: "Björk" }), "Björk Joga");
  assert.equal(plugin._searchQueryForTarget({ kind: "artist", title: "Björk" }), "Björk");
});

test("rankCandidates: drops dead and off-artist results, prefers the asked format", () => {
  const rows = plugin._runDefOnBody(plugin._WEB_DEFS.filter((d) => d.id === "tpb")[0], fix("apibay-search.json"));
  const ranked = plugin._rankCandidates(rows, { title: "Joga", artist: "Björk", album: "Homogenic", format: "flac" });
  assert.ok(ranked.length > 0 && ranked.length <= 3);
  for (const r of ranked) assert.notEqual(r.nbSeeders, 0, "a zero-seed result is never a candidate");
  assert.match(ranked[0].fileName, /FLAC/i);
  assert.equal(plugin._rankCandidates(rows, { title: "Joga", artist: "Radiohead" }).length, 0);
});

test("mergeMetadata: primary names win, tags fill the gaps", () => {
  const m = plugin._mergeMetadata({ title: "Jóga", artist: "Björk" }, { title: "Joga (Remastered)", artist: "Bjork", album: "Homogenic", track_number: 3, year: 1997 });
  assert.equal(m.title, "Jóga");
  assert.equal(m.album, "Homogenic");
  assert.equal(m.trackNumber, 3);
  assert.equal(plugin._mergeMetadata(null, { title: "T" }).title, "T");
});

test("fileUrlFor escapes only %, which the host's copy step percent-decodes", () => {
  assert.equal(plugin._fileUrlFor("/data/tmp/job-1/100% Pure/01 Song #1.flac"), "file:///data/tmp/job-1/100%25 Pure/01 Song #1.flac");
  assert.equal(decodeURIComponent(plugin._fileUrlFor("/a/100% b.mp3").slice(7)), "/a/100% b.mp3");
});

// --- Search -------------------------------------------------------------------

test("search: results become a sortable table; a failing site is a notice, not an error", async () => {
  const { api } = await activated({ fetch: apibayOnly, kv: { settings: { disabledIndexers: { x1337: true, bitsearch: true, rargb: true } } } });
  await fire(api, "rqbit:add", { query: "bjork homogenic" });
  const hosts = api.calls.fetch.map((c) => new URL(c.url).host);
  assert.ok(hosts.includes("apibay.org") && hosts.includes("nyaa.si"));
  assert.ok(!hosts.includes("1337x.to"), "a disabled site is never asked");
  const view = lastView(api, "rqbit");
  const list = findNode(view, (n) => n.type === "track-row-list");
  assert.ok(list, "results render as a list");
  assert.ok(list.columns.some((c) => c.id === "seeders"));
  assert.ok(list.items.length >= 5);
  assert.equal(list.items[0].cells.seeders, "10", "sorted by seeders, most first");
  assert.ok(textsIn(view).some((t) => /^Nyaa: HTTP 403/.test(t)), "the dead site is named");

  await fire(api, "rqbit:result-sort", { column: "size" });
  const sorted = findNode(lastView(api, "rqbit"), (n) => n.type === "track-row-list");
  assert.equal(sorted.sortBy, "size");
  assert.equal(sorted.items[0].cells.size, "1.74 GB");
});

test("search: every site off says so instead of searching nothing", async () => {
  const off = {};
  for (const d of plugin._WEB_DEFS) off[d.id] = true;
  const { api } = await activated({ fetch: apibayOnly, kv: { settings: { disabledIndexers: off } } });
  await fire(api, "rqbit:add", { query: "bjork" });
  assert.equal(api.calls.fetch.length, 0);
  assert.ok(textsIn(lastView(api, "rqbit")).some((t) => /Every search site is turned off/.test(t)));
});

test("indexer toggles persist", async () => {
  const { api } = await activated({});
  await fire(api, "rqbit:indexer:nyaa", { checked: false });
  assert.deepEqual(api.storage._kv.get("settings").disabledIndexers, { nyaa: true });
  await fire(api, "rqbit:indexer:nyaa", { checked: true });
  assert.deepEqual(api.storage._kv.get("settings").disabledIndexers, {});
});

test("Download on a result starts a whole-torrent job into the destination", async () => {
  const { api } = await activated({
    fetch: apibayOnly,
    kv: { settings: { destCollectionId: "7", disabledIndexers: disabledAllBut("tpb") } },
    exec: [{ match: { cmd: "rqbit", argsInclude: ["-e"] }, result: { exitCode: 0, lines: runLines() } }],
  });
  await fire(api, "rqbit:add", { query: "bjork homogenic" });
  const list = findNode(lastView(api, "rqbit"), (n) => n.type === "track-row-list");
  await fire(api, "rqbit:result-download", { itemId: list.items[0].id });
  assert.equal(api.calls.exec.length, 1);
  const args = api.calls.exec[0].args;
  assert.equal(args[args.indexOf("-o") + 1], "/music");
  assert.match(args[args.length - 1], /^magnet:\?xt=urn:btih:[0-9a-f]{40}/);
  assert.deepEqual(api.calls.resync, [7]);
});

// --- Pick tracks ----------------------------------------------------------------

test("Pick tracks lists the files and hands picked ones to the download modal", async () => {
  const { api } = await activated({
    fetch: apibayOnly,
    kv: { settings: { disabledIndexers: disabledAllBut("tpb") } },
    exec: [{ match: { cmd: "rqbit", argsInclude: ["-l"] }, result: { exitCode: 0, lines: LISTING } }],
  });
  await fire(api, "rqbit:add", { query: "bjork homogenic" });
  const results = findNode(lastView(api, "rqbit"), (n) => n.type === "track-row-list");
  const resultTitle = results.items[0].title;
  await fire(api, "rqbit:result-browse", { itemId: results.items[0].id });

  assert.ok(api.calls.exec[0].args.includes("-l"));
  const files = findNode(lastView(api, "rqbit"), (n) => n.type === "track-row-list");
  assert.equal(files.items.length, 3);
  assert.equal(files.contextMenu, false);
  assert.deepEqual(files.items[1].actions, [], "cover.jpg offers nothing");
  assert.deepEqual(files.selectionPresets[0].ids, ["0", "2"]);

  fire(api, "rqbit:file-download", { selectedIds: ["0", "1", "2"] });
  assert.equal(api.calls.requestAction.length, 1);
  const { action, payload } = api.calls.requestAction[0];
  assert.equal(action, "download-tracks");
  assert.equal(payload.providerId, "rqbit-download");
  assert.equal(payload.tracks.length, 2, "only the audio files");
  assert.equal(payload.tracks[0].title, "First Song");
  assert.equal(payload.tracks[0].artist_name, plugin._parseReleaseName(resultTitle).artist);
  const ref = plugin._parseRqbitUri(payload.tracks[0].uri);
  assert.equal(ref.kind, "file");
  assert.equal(ref.path, "01 - First Song.mp3");
  assert.match(ref.source, /^magnet:/);

  await fire(api, "rqbit:browse-close", {});
  const back = findNode(lastView(api, "rqbit"), (n) => n.type === "track-row-list");
  assert.equal(back.items.length, results.items.length, "← Results returns to the search");
});

test("a dead listing shows its reason in place of the files", async () => {
  const { api } = await activated({
    fetch: apibayOnly,
    kv: { settings: { disabledIndexers: disabledAllBut("tpb") } },
    exec: [{ match: { cmd: "rqbit", argsInclude: ["-l"] }, result: { exitCode: 1, lines: ['2026-09-24T06:52:27Z ERROR rqbit: error adding "x": no way to discover torrent metainfo'] } }],
  });
  await fire(api, "rqbit:add", { query: "bjork homogenic" });
  const results = findNode(lastView(api, "rqbit"), (n) => n.type === "track-row-list");
  await fire(api, "rqbit:result-browse", { itemId: results.items[0].id });
  assert.ok(textsIn(lastView(api, "rqbit")).some((t) => /Could not find any peer/.test(t)));
});

// --- Download provider ------------------------------------------------------------

test("by URI: fetches only that file into a temp folder and answers with its path", async () => {
  const holder = {};
  const { api } = await activated({
    exec: [fetchRule(holder, ["album/01 - First Song.mp3", "album/cover.jpg"])],
    tags: {},
  });
  holder.api = api;
  const res = await callHandler(api, "byUri:rqbit-download", plugin._fileUri(MAGNET, "01 - First Song.mp3"), "any");

  const args = api.calls.exec[0].args;
  assert.equal(args[args.indexOf("-r") + 1], "^01 - First Song\\.mp3$");
  assert.match(args[args.indexOf("-o") + 1], /^\/data\/tmp\/job-/);
  assert.match(res.url, /^file:\/\/\/data\/tmp\/job-[^/]+\/album\/01 - First Song\.mp3$/);
  assert.equal(res.ext, "mp3");
  assert.ok(api.calls.progress.some((p) => p.percent === 50), "rqbit's percent reaches the modal");
  assert.ok(api.calls.progress.some((p) => /Finding peers/.test(p.label || "")), "the wait for peers is labelled");
  assert.deepEqual(api.calls.readTags.length, 1, "the file's own tags are read");
});

test("by URI: a failed run removes its temp folder and throws rqbit's reason", async () => {
  const { api } = await activated({
    exec: [{ match: { cmd: "rqbit", argsInclude: ["-e"] }, result: { exitCode: 1, lines: ['2026-09-24T06:52:27Z ERROR rqbit: error adding "x": none of the filenames match the given regex'] } }],
  });
  await assert.rejects(
    callHandler(api, "byUri:rqbit-download", plugin._fileUri(MAGNET, "01 - Gone.mp3"), "any"),
    /no file named “01 - Gone\.mp3”/
  );
  assert.ok(api.calls.filesRemove.some((p) => /^tmp\/job-/.test(p)));
});

test("by URI: the modal's Cancel rejects with \"Cancelled\" verbatim", async () => {
  const { api } = await activated({
    exec: [{ match: { cmd: "rqbit", argsInclude: ["-e"] }, result: () => { throw new Error("Cancelled"); } }],
  });
  await assert.rejects(callHandler(api, "byUri:rqbit-download", plugin._fileUri(MAGNET, "a.mp3"), "any"), /^Error: Cancelled$/);
});

test("by URI: not ours, or rqbit not installed", async () => {
  const { api } = await activated({});
  assert.equal(await callHandler(api, "byUri:rqbit-download", "qbt://abc/1", "any"), null);
  const missing = await activated({ dependency: { name: "rqbit", installed: false } });
  await assert.rejects(callHandler(missing.api, "byUri:rqbit-download", plugin._fileUri(MAGNET, "a.mp3"), "any"), /not installed/);
});

test("hunt: searches, skips a torrent without the track, fetches it from the next", async () => {
  const holder = {};
  let listings = 0;
  const { api } = await activated({
    fetch: apibayOnly,
    kv: { settings: { disabledIndexers: disabledAllBut("tpb") } },
    exec: [
      {
        match: { cmd: "rqbit", argsInclude: ["-l"] },
        result: () => {
          listings++;
          const lines = listings === 1
            ? ["2026-09-24T06:52:27Z  INFO rqbit: File 01 - Hunter.flac, size 30.0Mi"]
            : ["2026-09-24T06:52:27Z  INFO rqbit: File Homogenic/03 - Joga.flac, size 31.0Mi", "2026-09-24T06:52:27Z  INFO rqbit: File Homogenic/03 - Joga.mp3, size 9.0Mi"];
          return { exitCode: 0, lines };
        },
      },
      fetchRule(holder, ["Bjork - Homogenic/Homogenic/03 - Joga.flac"]),
    ],
    tags: {},
  });
  holder.api = api;
  const res = await callHandler(api, "byMeta:rqbit-download", "Jóga", "Björk", "Homogenic", 305, "flac");

  assert.equal(listings, 2);
  const dl = api.calls.exec.filter((c) => c.args.includes("-e"))[0];
  assert.equal(dl.args[dl.args.indexOf("-r") + 1], "^03 - Joga\\.flac$");
  assert.match(res.url, /\/Homogenic\/03 - Joga\.flac$/);
  assert.equal(res.metadata.title, "Jóga", "the user's own names beat a guess");
  assert.equal(res.ext, "flac");
  // Monotonic: search < candidates < download.
  const pcts = api.calls.progress.filter((p) => typeof p.percent === "number").map((p) => p.percent);
  for (let i = 1; i < pcts.length; i++) assert.ok(pcts[i] >= pcts[i - 1], "progress never walks backwards: " + pcts.join(","));
});

test("hunt: nothing on the sites is a reason, not a silent null", async () => {
  const { api } = await activated({ fetch: async () => ({ status: 200, body: "[]" }), kv: { settings: { disabledIndexers: disabledAllBut("tpb") } } });
  await assert.rejects(callHandler(api, "byMeta:rqbit-download", "Joga", "Bjork", "Homogenic", 0, "any"), /No torrent for “Bjork — Joga”/);
});

test("the find:// URI from the context menu runs the same hunt inside the modal", async () => {
  const { api } = await activated({});
  callHandler(api, "menu:rqbit-download", { kind: "track", title: "Jóga", artistName: "Björk", albumTitle: "Homogenic" });
  const { action, payload } = api.calls.requestAction[0];
  assert.equal(action, "download-tracks");
  assert.equal(payload.tracks.length, 1);
  const ref = plugin._parseRqbitUri(payload.tracks[0].uri);
  assert.equal(ref.kind, "find");
  assert.equal(ref.want.artist, "Björk");
  assert.equal(api.calls.exec.length, 0, "nothing runs until the modal resolves");
});

test("Find torrents opens the view and searches artist + album", async () => {
  const { api } = await activated({ fetch: apibayOnly, kv: { settings: { disabledIndexers: disabledAllBut("tpb") } } });
  await callHandler(api, "menu:rqbit-find-torrents", { kind: "album", title: "Homogenic", artistName: "Björk", albumTitle: "Homogenic" });
  assert.deepEqual(api.calls.navigate, ["rqbit"]);
  assert.match(decodeURIComponent(api.calls.fetch[0].url), /q=Björk Homogenic/);
});

test("the stream resolver entry declines every play, instantly", async () => {
  const { api } = await activated({});
  assert.equal(await callHandler(api, "stream:rqbit-find", "Joga", "Bjork", "Homogenic", 300, {}), null);
  assert.equal(api.calls.exec.length + api.calls.fetch.length, 0);
});

test("qualities are offered for the modal", async () => {
  const { api } = await activated({});
  const q = callHandler(api, "qualities:rqbit-download");
  assert.deepEqual(q.map((o) => o.value), ["any", "flac", "mp3"]);
});

test("activation clears temp downloads left by a previous session", async () => {
  const { api } = await activated({ files: ["tmp/job-old/album/x.mp3"] });
  await new Promise((r) => setImmediate(r));
  assert.equal(api._files.size, 0);
});
