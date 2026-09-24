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
  const calls = { exec: [], log: [], setViewData: [], showNotification: [], resync: [], openPath: [], trash: [], cancel: [] };
  const handlers = {};
  const kv = new Map(Object.entries(config.kv || {}));
  const execRules = config.exec || [];
  const dependency = config.dependency === undefined
    ? { name: "rqbit", installed: true, version: "9.0.1", origin: "managed", latest: null }
    : config.dependency;
  const collections = config.collections || [{ id: 7, name: "Music", path: "/music" }];

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
    },
    storage: {
      get: async (k) => (kv.has(k) ? kv.get(k) : null),
      set: async (k, v) => { kv.set(k, v); },
      delete: async (k) => { kv.delete(k); },
      _kv: kv,
    },
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
      navigateToView: () => {},
    },
  };

  return api;
}

// Fires a registered UI action as the host would.
function fire(api, actionId, payload) {
  const fn = api._handlers["action:" + actionId];
  if (!fn) throw new Error("no handler registered for " + actionId);
  return fn(payload);
}

module.exports = { makeApi, fire };
