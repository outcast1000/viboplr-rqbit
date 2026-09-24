// End to end through the mock host: activate, add a source, drive rqbit's
// captured output through onOutput, and check what the user sees.
const { test } = require("node:test");
const assert = require("node:assert");
const { loadPlugin } = require("./harness/sandbox.js");
const { makeApi, fire } = require("./harness/mock-api.js");

const MAGNET = "magnet:?xt=urn:btih:437aa30064c7eda95dbc3dc6d2da231adc12a9b0&dn=album";

const GOOD_RUN = [
  "2026-09-24T06:52:26.518024Z  INFO rqbit: increased open file limit limit=1048576",
  "2026-09-24T06:52:26.719379Z  INFO librqbit::session: will download filename=01 - First Song.mp3",
  '2026-09-24T06:52:26.720204Z  INFO librqbit::session: added torrent name="album"',
  "2026-09-24T06:52:30.102503Z  INFO rqbit: [0]: 25.17% (6.00Mi / 23.84Mi), ↓1.88 MiB/s, ↑0.00 MiB/s (0), ETA: 9.481s, {live: 1, queued: 0, dead: 0, known: 1}",
  "2026-09-24T06:52:31.103876Z  INFO rqbit: [0]: 100.00% (23.84Mi / 23.84Mi), ↓1.91 MiB/s, ↑0.00 MiB/s (0), {live: 1, queued: 0, dead: 0, known: 1}",
  "2026-09-24T06:52:26.804325Z  INFO librqbit::torrent_state::live: torrent finished downloading id=0 info_hash=437aa30064c7eda95dbc3dc6d2da231adc12a9b0",
  "2026-09-24T06:52:26.804507Z  INFO rqbit: All downloads completed, exiting",
];

function lastView(api, id) {
  const rows = api.calls.setViewData.filter((c) => c.id === id);
  return rows[rows.length - 1].data;
}

function textsIn(node, out) {
  out = out || [];
  if (!node) return out;
  if (node.type === "text") out.push(node.content);
  for (const c of node.children || []) textsIn(c, out);
  if (node.control) textsIn(node.control, out);
  return out;
}

async function activated(config) {
  const plugin = loadPlugin();
  const api = makeApi(config);
  await plugin.activate(api);
  return { plugin, api };
}

test("activate renders the settings panel and the view", async () => {
  const { api } = await activated({});
  assert.ok(api.calls.setViewData.some((c) => c.id === "rqbit-settings"));
  assert.ok(api.calls.setViewData.some((c) => c.id === "rqbit"));
  const texts = textsIn(lastView(api, "rqbit"));
  assert.ok(texts.some((t) => /Choose the collection/.test(t)), "no destination yet → the view says so");
});

test("a download runs rqbit once, lands, and rescans the destination", async () => {
  const { api } = await activated({
    kv: { settings: { destCollectionId: "7", audioOnly: true } },
    exec: [{ match: { cmd: "rqbit", argsInclude: ["download", "-e"] }, result: { exitCode: 0, lines: GOOD_RUN } }],
  });
  await fire(api, "rqbit:add", { query: MAGNET });

  assert.equal(api.calls.exec.length, 1);
  const { args } = api.calls.exec[0];
  assert.equal(args[args.indexOf("-o") + 1], "/music", "downloads into the chosen collection's path");
  assert.ok(args.includes("-r"), "audio-only filter on by default");
  assert.equal(args[args.length - 1], MAGNET);

  assert.deepEqual(api.calls.resync, [7], "the collection is rescanned exactly once");
  assert.ok(api.calls.showNotification.some((m) => /Downloaded album/.test(m)));

  const texts = textsIn(lastView(api, "rqbit"));
  assert.ok(texts.includes("album"), "the row is titled with rqbit's torrent name, not the magnet");
  assert.ok(texts.some((t) => /^Done · 23\.8 MB · in album$/.test(t)), texts.join(" | "));
});

const FAILED_AFTER_START = [
  '2026-09-24T06:52:26.720204Z  INFO librqbit::session: added torrent name="album"',
  '2026-09-24T06:53:07.473462Z ERROR rqbit: error adding "m": none of the filenames match the given regex',
  "2026-09-24T06:53:07.473481Z ERROR rqbit: error running rqbit: no torrents were added",
];

test("a failed run reports the reason, trashes its own folder, and does not rescan", async () => {
  const { api } = await activated({
    kv: { settings: { destCollectionId: "7", audioOnly: true } },
    exec: [{ match: { cmd: "rqbit", argsInclude: ["download"] }, result: { exitCode: 1, lines: FAILED_AFTER_START } }],
  });
  await fire(api, "rqbit:add", { query: MAGNET });
  assert.deepEqual(api.calls.resync, []);
  assert.deepEqual(api.calls.trash, [{ id: 7, rel: "album" }], "the torrent's own folder, relative to the collection");
  const texts = textsIn(lastView(api, "rqbit"));
  assert.ok(texts.some((t) => /Failed — No audio files in this torrent.*Partial files removed\./.test(t)), texts.join(" | "));
  assert.ok(!texts.some((t) => /Partial files may be left/.test(t)), "no warning once the folder is gone");
  assert.ok(api.calls.showNotification.some((m) => /No audio files/.test(m)));
});

test("on an older host without trashPath the leftover warning is shown instead", async () => {
  const { api } = await activated({
    kv: { settings: { destCollectionId: "7" } },
    noTrashPath: true,
    exec: [{ match: { cmd: "rqbit" }, result: { exitCode: 1, lines: FAILED_AFTER_START } }],
  });
  await fire(api, "rqbit:add", { query: MAGNET });
  const texts = textsIn(lastView(api, "rqbit"));
  assert.ok(texts.some((t) => /Partial files may be left in \/music\/album/.test(t)));
});

test("a 'files already exist' refusal never trashes anything — those files are the user's", async () => {
  const { api } = await activated({
    kv: { settings: { destCollectionId: "7" } },
    exec: [{
      match: { cmd: "rqbit" },
      result: {
        exitCode: 1,
        lines: [
          '2026-09-24T06:52:26.720204Z  INFO librqbit::session: added torrent name="album"',
          '2026-09-24T06:53:15.739856Z ERROR rqbit: error adding "m": error creating a new file (because allow_overwrite = false) "/music/album/01.mp3"',
          "2026-09-24T06:53:15.739876Z ERROR rqbit: error running rqbit: no torrents were added",
        ],
      },
    }],
  });
  await fire(api, "rqbit:add", { query: MAGNET });
  assert.deepEqual(api.calls.trash, []);
  const texts = textsIn(lastView(api, "rqbit"));
  assert.ok(texts.some((t) => /already exist/.test(t)));
});

test("a failed run whose folder was never created has nothing to trash", async () => {
  const { api } = await activated({
    kv: { settings: { destCollectionId: "7" } },
    exec: [{ match: { cmd: "rqbit" }, result: { exitCode: 1, lines: ['ERROR rqbit: error adding "m": input address stream exhausted, no way to discover torrent metainfo'] } }],
  });
  await fire(api, "rqbit:add", { query: MAGNET });
  assert.deepEqual(api.calls.trash, [], "no torrent name → rqbit wrote nothing");
});

test("Cancel stops the process through the exec handle and cleans up", async () => {
  const { api } = await activated({
    kv: { settings: { destCollectionId: "7" } },
    exec: [{
      match: { cmd: "rqbit" },
      result: { hang: true, lines: ['2026-09-24T06:52:26.720204Z  INFO librqbit::session: added torrent name="album"'] },
    }],
  });
  const run = fire(api, "rqbit:add", { query: MAGNET });
  // Let the exec start and hand over its handle.
  await new Promise((r) => setImmediate(r));
  let texts = textsIn(lastView(api, "rqbit"));
  const view = lastView(api, "rqbit");
  const buttons = JSON.stringify(view);
  assert.ok(buttons.includes('"rqbit:cancel"'), "a running job with a handle shows Cancel");

  const job = view.children.find((c) => c.type === "section");
  const cancelBtn = job.children.find((c) => c.type === "toolbar").buttons.find((b) => b.action === "rqbit:cancel");
  await fire(api, "rqbit:cancel", cancelBtn.data);
  await run;

  assert.deepEqual(api.calls.cancel, ["rqbit"]);
  assert.deepEqual(api.calls.trash, [{ id: 7, rel: "album" }]);
  assert.equal(api.calls.showNotification.length, 0, "a cancel is the user's own doing, not an error");
  texts = textsIn(lastView(api, "rqbit"));
  assert.ok(texts.some((t) => /^Cancelled · partial files removed$/.test(t)), texts.join(" | "));
});

test("the host's Cancelled rejection is not reported as a failure", async () => {
  const { api } = await activated({
    kv: { settings: { destCollectionId: "7" } },
    exec: [{ match: { cmd: "rqbit" }, result: () => Promise.reject(new Error("Cancelled")) }],
  });
  await fire(api, "rqbit:add", { query: MAGNET });
  assert.equal(api.calls.showNotification.length, 0);
  const texts = textsIn(lastView(api, "rqbit"));
  assert.ok(texts.includes("Cancelled"));
});

test("deactivate cancels what is still running", async () => {
  const { plugin, api } = await activated({
    kv: { settings: { destCollectionId: "7" } },
    exec: [{ match: { cmd: "rqbit" }, result: { hang: true, lines: [] } }],
  });
  const run = fire(api, "rqbit:add", { query: MAGNET });
  await new Promise((r) => setImmediate(r));
  plugin.deactivate();
  assert.deepEqual(api.calls.cancel, ["rqbit"]);
  await run.catch(() => {});
});

test("nothing runs without a destination or without rqbit", async () => {
  const noDest = await activated({});
  await fire(noDest.api, "rqbit:add", { query: MAGNET });
  assert.equal(noDest.api.calls.exec.length, 0);
  assert.ok(noDest.api.calls.showNotification.some((m) => /Choose the collection/.test(m)));

  const noBin = await activated({ kv: { settings: { destCollectionId: "7" } }, dependency: { installed: false, version: null, origin: null } });
  await fire(noBin.api, "rqbit:add", { query: MAGNET });
  assert.equal(noBin.api.calls.exec.length, 0);
  assert.ok(noBin.api.calls.showNotification.some((m) => /not installed/.test(m)));
});

test("garbage in the box is refused before rqbit is touched", async () => {
  const { api } = await activated({ kv: { settings: { destCollectionId: "7" } } });
  await fire(api, "rqbit:add", { query: "some album name" });
  assert.equal(api.calls.exec.length, 0);
  assert.ok(api.calls.showNotification.some((m) => /paste a magnet link/.test(m)));
});

test("settings actions persist and re-render", async () => {
  const { api } = await activated({});
  await fire(api, "rqbit:set-dest", { value: "7" });
  await fire(api, "rqbit:set-audio-only", { checked: false });
  assert.deepEqual(api.storage._kv.get("settings"), { destCollectionId: "7", audioOnly: false });
  const texts = textsIn(lastView(api, "rqbit"));
  assert.ok(!texts.some((t) => /Choose the collection/.test(t)), "readiness banner gone once a destination is set");
});
