// In-memory fake of the viboplr host `api` bridge. Only the surface index.js uses
// is implemented. makeApi(config) returns the api plus `calls` (recorded
// invocations) and `_handlers` (callbacks the plugin registered).
//
// exec rules: config.exec = [{ match: { cmd, argsInclude? }, result | fn(cmd, args, opts) }].
// A rule's result may carry `lines` — each is fed to opts.onOutput before the
// promise resolves, which is how a test drives the progress parser end to end.
// `hang: true` makes the exec never resolve on its own: its lines are emitted,
// then it waits for the handle given to opts.onStart to be cancelled, and
// rejects with "Cancelled" exactly as the host does.

function execMatches(entry, cmd, args) {
  if (entry.match.cmd !== cmd) return false;
  const inc = entry.match.argsInclude || [];
  const joined = args.join(" ");
  return inc.every((s) => joined.includes(s));
}

function makeApi(config) {
  config = config || {};
  const calls = { exec: [], log: [], setViewData: [], showNotification: [], resync: [], openPath: [], trash: [], cancel: [], setViewHeader: [], fetch: [], requestAction: [], progress: [], filesRemove: [], readTags: [], navigate: [] };
  const handlers = {};
  const kv = new Map(Object.entries(config.kv || {}));
  const execRules = config.exec || [];
  const dependency = config.dependency === undefined
    ? { name: "rqbit", installed: true, version: "9.0.1", origin: "managed", latest: null }
    : config.dependency;
  const collections = config.collections || [{ id: 7, name: "Music", path: "/music" }];
  // Plugin file storage as a set of file paths ("tmp/job-1/album/01.flac"),
  // rooted at /data. Directories exist implicitly; a test (or an exec rule)
  // adds files with api._files.add(path).
  const files = new Set(config.files || []);
  const DATA = "/data";
  const isDirPath = (p) => { for (const f of files) if (f.startsWith(p + "/")) return true; return false; };

  const api = {
    calls,
    _handlers: handlers,
    appVersion: config.appVersion || "1.0.71",
    log: (level, msg, section) => { calls.log.push({ level, msg, section }); },
    system: {
      exec: async (cmd, args, opts) => {
        args = args || [];
        calls.exec.push({ cmd, args, opts });
        let cancelled = false;
        let onCancel = null;
        if (opts && typeof opts.onStart === "function") {
          opts.onStart({
            cancel: async () => {
              calls.cancel.push(cmd);
              cancelled = true;
              if (onCancel) onCancel();
              return true;
            },
          });
        }
        for (const rule of execRules) {
          if (execMatches(rule, cmd, args)) {
            let r = typeof rule.result === "function" ? rule.result(cmd, args, opts) : rule.result;
            if (r && typeof r.then === "function") r = await r;
            r = r || {};
            if (opts && typeof opts.onOutput === "function" && Array.isArray(r.lines)) {
              for (const line of r.lines) opts.onOutput(line, "stdout");
            }
            if (r.hang) {
              if (cancelled) throw new Error("Cancelled");
              await new Promise((resolve) => { onCancel = resolve; });
              throw new Error("Cancelled");
            }
            return Object.assign({ exitCode: 0, stdout: (r.lines || []).join("\n"), stderr: "" }, r);
          }
        }
        return { exitCode: 1, stdout: "", stderr: "" };
      },
      getDependency: async () => dependency,
      openPath: async (p) => { calls.openPath.push(p); },
      ...(config.noReadTags ? {} : {
        readAudioTags: async (paths) => { calls.readTags.push(paths); return paths.map((p) => (config.tags && config.tags[p]) || null); },
      }),
    },
    network: {
      // config.fetch(url) → { status, body, url? } | throws.
      fetch: async (url, init) => {
        calls.fetch.push({ url, init });
        if (!config.fetch) throw new Error("no network in this test");
        const r = await config.fetch(url, init);
        return { status: r.status == null ? 200 : r.status, url: r.url || url, text: async () => r.body || "" };
      },
    },
    downloads: {
      onResolveByUri: (id, fn) => { handlers["byUri:" + id] = fn; },
      onResolveByMetadata: (id, fn) => { handlers["byMeta:" + id] = fn; },
      onGetQualities: (id, fn) => { handlers["qualities:" + id] = fn; },
      reportProgress: (p) => { calls.progress.push(p); },
    },
    playback: {
      onStreamResolve: (id, fn) => { handlers["stream:" + id] = fn; },
    },
    contextMenu: {
      onAction: (id, fn) => { handlers["menu:" + id] = fn; },
    },
    storage: {
      get: async (k) => (kv.has(k) ? kv.get(k) : null),
      set: async (k, v) => { kv.set(k, v); },
      delete: async (k) => { kv.delete(k); },
      _kv: kv,
      ...(config.noFiles ? {} : {
        files: {
          getPath: async (segs) => {
            const p = segs.join("/");
            return files.has(p) || isDirPath(p) ? DATA + "/" + p : null;
          },
          writeText: async (segs) => { files.add(segs.join("/")); },
          list: async (segs) => {
            const p = segs.join("/");
            if (!isDirPath(p)) throw new Error("no such directory: " + p);
            const seen = new Map();
            for (const f of files) {
              if (!f.startsWith(p + "/")) continue;
              const rest = f.slice(p.length + 1).split("/");
              if (!seen.has(rest[0])) seen.set(rest[0], rest.length > 1);
            }
            return [...seen].map(([name, isDir]) => ({ name, isDir }));
          },
          remove: async (segs) => {
            const p = segs.join("/");
            calls.filesRemove.push(p);
            for (const f of [...files]) if (f === p || f.startsWith(p + "/")) files.delete(f);
          },
        },
      }),
    },
    _files: files,
    collections: Object.assign(
      {
        getLocalCollections: async () => collections,
        resync: async (id) => { calls.resync.push(id); },
      },
      // Absent when the test models an older host without the API.
      config.noTrashPath ? {} : {
        trashPath: async (id, rel) => {
          calls.trash.push({ id, rel });
          if (config.trashFails) throw new Error("boom");
        },
      },
    ),
    ui: {
      onAction: (id, fn) => { handlers["action:" + id] = fn; },
      setViewData: (id, data, opts) => { calls.setViewData.push({ id, data, opts }); },
      showNotification: (message) => { calls.showNotification.push(message); },
      navigateToView: (id) => { calls.navigate.push(id); },
      requestAction: (action, payload) => { calls.requestAction.push({ action, payload }); },
      // Hosts >= 1.0.77 only; config.noViewHeader models an older host.
      ...(config.noViewHeader ? {} : {
        setViewHeader: (id, header) => { calls.setViewHeader.push({ id, header }); },
      }),
    },
  };

  return api;
}

// Calls a registered host-facing handler: "byUri:rqbit-download",
// "menu:rqbit-download", "stream:rqbit-find", …
function callHandler(api, key, ...args) {
  const fn = api._handlers[key];
  if (!fn) throw new Error("no handler registered for " + key);
  return fn(...args);
}

// Fires a registered UI action as the host would.
function fire(api, actionId, payload) {
  const fn = api._handlers["action:" + actionId];
  if (!fn) throw new Error("no handler registered for " + actionId);
  return fn(payload);
}

module.exports = { makeApi, fire, callHandler };
