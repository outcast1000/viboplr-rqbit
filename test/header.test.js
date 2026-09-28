// The host-drawn view header: the pure viewHeaderFor, and its change-gated push.
const { test } = require("node:test");
const assert = require("node:assert");
const { loadPlugin } = require("./harness/sandbox.js");
const { makeApi, fire } = require("./harness/mock-api.js");

const plugin = loadPlugin();
const DEP = { installed: true, version: "9.0.1", origin: "managed" };
const DEST = { id: 7, name: "Music", path: "/music" };

test("viewHeaderFor: not yet checked / host too old / not installed", () => {
  assert.deepEqual(plugin._viewHeaderFor(null, DEST, [], true).status, { variant: "muted", label: "Checking…" });
  const old = plugin._viewHeaderFor({ installed: false, hostTooOld: true }, DEST, [], true);
  assert.deepEqual(old.status, { variant: "error", label: "Update Viboplr" });
  const missing = plugin._viewHeaderFor({ installed: false }, DEST, [], true);
  assert.deepEqual(missing.status, { variant: "warning", label: "Not installed" });
  assert.equal(missing.subtitle, "Download music over BitTorrent into your library");
  assert.deepEqual(missing.actions, [], "the fix lives in the view's banner, not the header");
});

test("viewHeaderFor: installed but no destination", () => {
  const h = plugin._viewHeaderFor(DEP, null, [], true);
  assert.equal(h.subtitle, "rqbit 9.0.1");
  assert.deepEqual(h.status, { variant: "warning", label: "No destination" });
  assert.deepEqual(h.actions, []);
});

test("viewHeaderFor: ready, with the open-folder action when the host can", () => {
  const h = plugin._viewHeaderFor(DEP, DEST, [{ state: "done" }, { state: "failed" }], true);
  assert.equal(h.subtitle, "rqbit 9.0.1 · into Music");
  assert.deepEqual(h.status, { variant: "success", label: "Ready" });
  assert.deepEqual(h.actions, [{ label: "Open folder", action: "rqbit:open-dest", variant: "secondary" }]);
  assert.deepEqual(plugin._viewHeaderFor(DEP, DEST, [], false).actions, []);
});

test("viewHeaderFor: counts running jobs (starting, downloading, stopping)", () => {
  const jobs = [{ state: "starting" }, { state: "downloading" }, { state: "cancelling" }, { state: "done" }];
  const h = plugin._viewHeaderFor(DEP, DEST, jobs, true);
  assert.equal(h.subtitle, "rqbit 9.0.1 · into Music · 3 downloading");
  assert.deepEqual(h.status, { variant: "success", label: "Downloading" });
});

test("viewHeaderFor: fits the host's limits", () => {
  const h = plugin._viewHeaderFor(DEP, { name: "x".repeat(40), path: "/p" }, [], true);
  assert.ok(h.subtitle.length <= 160);
  assert.ok(h.status.label.length <= 32);
  assert.ok(h.actions.length <= 2);
});

test("activate pushes the header once, and only again when it changes", async () => {
  const p = loadPlugin();
  const api = makeApi({ kv: { settings: { destCollectionId: "7", audioOnly: true } } });
  await p.activate(api);
  assert.equal(api.calls.setViewHeader.length, 1);
  assert.equal(api.calls.setViewHeader[0].id, "rqbit");
  assert.deepEqual(api.calls.setViewHeader[0].header.status, { variant: "success", label: "Ready" });
  await fire(api, "rqbit:recheck");
  assert.equal(api.calls.setViewHeader.length, 1, "an unchanged header is not re-sent");
  await fire(api, "rqbit:set-dest", { value: "" });
  assert.equal(api.calls.setViewHeader.length, 2);
  assert.equal(api.calls.setViewHeader[1].header.status.label, "No destination");
});

test("re-activating after deactivate pushes the header again", async () => {
  const p = loadPlugin();
  const api = makeApi({});
  await p.activate(api);
  p.deactivate();
  const api2 = makeApi({});
  await p.activate(api2);
  assert.equal(api2.calls.setViewHeader.length, 1);
});

test("the header's Open folder opens the destination collection", async () => {
  const p = loadPlugin();
  const api = makeApi({ kv: { settings: { destCollectionId: "7" } } });
  await p.activate(api);
  await fire(api, "rqbit:open-dest");
  assert.deepEqual(api.calls.openPath, ["/music"]);
});

test("an older host without setViewHeader still activates and renders", async () => {
  const p = loadPlugin();
  const api = makeApi({ noViewHeader: true });
  await p.activate(api);
  assert.ok(api.calls.setViewData.some((c) => c.id === "rqbit"));
  assert.equal(api.calls.setViewHeader.length, 0);
});
