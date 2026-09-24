// viboplr-rqbit — download music over BitTorrent through the rqbit CLI.
//
// Design notes:
//  - rqbit runs as a ONE-SHOT subprocess per download (`rqbit download
//    --exit-on-finish`), the same shape as the yt-dlp plugin. Nothing is
//    installed as a service, nothing keeps running when the download ends, and
//    there is no torrent list to reconcile with — each job here IS the process.
//    That is the whole reason this is a separate plugin from viboplr-qbittorrent
//    (a resident client with a WebUI): the two shapes share almost nothing.
//  - The binary is the HOST's: `api.system.exec("rqbit", …)` is allow-listed by
//    the app's dependency registry and `api.system.getDependency("rqbit")` is
//    the only way this plugin learns whether it is installed. It never probes
//    `--version` and never checks GitHub itself.
//  - rqbit writes everything — logs, progress, listings — to STDOUT, one
//    `tracing` line each, and its exit code is trustworthy: 0 with "All
//    downloads completed" is success; a rejected source, a regex that matches
//    nothing or a file that already exists all exit 1 with an ERROR line.
//  - rqbit PREALLOCATES every file to its full size the moment a download
//    starts, so a cancelled or failed run leaves files that look complete by
//    size — and would be scanned into the library as music. A failed or
//    cancelled job therefore trashes its own folder through
//    `api.collections.trashPath` (host-checked to stay inside the collection),
//    except when rqbit refused to start because the files ALREADY existed:
//    those are the user's, not ours. On a host without that API the view warns
//    and offers the folder instead.
//  - A running download is stopped through the `onStart` exec handle; without
//    it (older host) the Cancel button is simply absent — a no-peer magnet then
//    hangs until the app quits, which the view says out loud after 90s.
//  - Global rqbit flags go BEFORE the subcommand; after it they are a clap error.

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------
var VIEW_ID = "rqbit";
var SETTINGS_ID = "rqbit-settings";
var STORAGE_KEY = "settings";
var DEP_NAME = "rqbit";

// Everything after `-v info` is a fix for a specific problem:
//  --disable-dht-persistence  two concurrent downloads would otherwise fight
//                             over one DHT state file
//  --disable-upnp-port-forward a one-shot process has no business rewriting the
//                             router (rqbit's own `download` default agrees, this
//                             pins it)
// `-v info` is not noise control — the `-l` listing and the progress lines are
// info-level, so anything quieter prints nothing usable.
var RQBIT_GLOBAL_ARGS = ["-v", "info", "--disable-dht-persistence", "--disable-upnp-port-forward"];

// Media a music library can play. Everything else in a torrent (nfo, sfv,
// cover scans, sample videos) is skipped when the audio-only filter is on.
var AUDIO_FILE_RE = "\\.(mp3|flac|m4a|aac|ogg|oga|opus|wav|aiff?|ape|wv|tta|dsf|dff|mpc|wma|mka|alac)$";

// Progress renders at most this often — rqbit prints one line per second per
// torrent, and every render is a host re-render of the whole view.
var RENDER_THROTTLE_MS = 500;

// A magnet with no reachable peers hangs rqbit forever, printing nothing (the
// spike measured 15s+ of silence). Past this with no output the job is shown as
// stuck, so the user knows to give up on it rather than wait.
var STUCK_AFTER_MS = 90000;

// ---------------------------------------------------------------------------
// Module state
// ---------------------------------------------------------------------------
var api = null;
var rqbitDep = null; // { installed, version, origin } | null (not yet asked)
var localCollections = [];
var jobs = []; // newest first; see startJob for the shape
var jobSeq = 0;
var lastRenderAt = 0;
var renderTimer = null;

// Settings (persisted).
var destCollectionId = "";
var audioOnly = true;

// ---------------------------------------------------------------------------
// Pure helpers — exported at the bottom for the test harness
// ---------------------------------------------------------------------------

function errText(e) {
  return e && e.message ? e.message : String(e);
}

// `rqbit 9.0.1` → "9.0.1". Null when the line isn't rqbit's.
function parseRqbitVersion(stdout) {
  var m = /^rqbit\s+(\d+\.\d+\.\d+\S*)/m.exec(String(stdout || ""));
  return m ? m[1] : null;
}

function isMagnet(s) {
  return /^magnet:\?/i.test(String(s || "").trim());
}

// What `rqbit download` accepts as a source: a magnet, an http(s) URL (a
// .torrent or a tracker's download link) or a local .torrent path.
function isTorrentSource(s) {
  var v = String(s || "").trim();
  if (!v) return false;
  if (isMagnet(v)) return /xt=urn:btih:[0-9a-z]{32,40}/i.test(v);
  if (/^https?:\/\//i.test(v)) return true;
  return /\.torrent$/i.test(v);
}

function infoHashOf(magnet) {
  var m = /xt=urn:btih:([0-9a-z]{32,40})/i.exec(String(magnet || ""));
  return m ? m[1].toLowerCase() : null;
}

// A name to show before rqbit tells us the real one: the magnet's `dn`, else
// the URL's last path segment, else a shortened hash.
function sourceDisplayName(source) {
  var s = String(source || "").trim();
  if (isMagnet(s)) {
    var m = /[?&]dn=([^&]+)/i.exec(s);
    if (m) {
      try { return decodeURIComponent(m[1].replace(/\+/g, " ")); } catch (e) { return m[1]; }
    }
    var hash = infoHashOf(s);
    return hash ? "magnet " + hash.slice(0, 8) + "…" : "magnet link";
  }
  var last = s.replace(/[?#].*$/, "").replace(/\/+$/, "").split("/").pop() || s;
  try { return decodeURIComponent(last); } catch (e) { return last; }
}

// Argv for one download. Global flags first (rqbit rejects them after the
// subcommand), then `download` with:
//  --disable-http-api  `download` otherwise opens an ephemeral HTTP port
//  -e                  exit when done (without it rqbit seeds forever)
//  -o                  the folder; rqbit creates `<folder>/<torrent name>/`
//  -r                  optional basename regex — only matching files download
function buildDownloadArgs(opts) {
  var args = RQBIT_GLOBAL_ARGS.concat(["download", "--disable-http-api", "-e", "-o", opts.outDir]);
  if (opts.filenameRe) args = args.concat(["-r", opts.filenameRe]);
  if (opts.overwrite) args.push("--overwrite");
  return args.concat([opts.source]);
}

// Argv for a metadata-only listing (`-l` prints the files and exits).
function buildListArgs(source) {
  return RQBIT_GLOBAL_ARGS.concat(["download", "--disable-http-api", "-l", source]);
}

// "23.84Mi" / "6" / "1.2Gi" → bytes. rqbit prints IEC prefixes without the B.
function parseSize(text) {
  var m = /^([\d.]+)\s*([KMGT]i?)?B?$/i.exec(String(text || "").trim());
  if (!m) return null;
  var n = parseFloat(m[1]);
  if (!isFinite(n)) return null;
  var unit = (m[2] || "").toUpperCase().replace("I", "");
  var mult = { "": 1, K: 1024, M: 1024 * 1024, G: 1024 * 1024 * 1024, T: 1024 * 1024 * 1024 * 1024 }[unit];
  return mult ? Math.round(n * mult) : null;
}

// One progress line, as rqbit 9 prints it (verified against the binary):
//   INFO rqbit: [0]: 33.55% (8.00Mi / 23.84Mi), ↓1.91 MiB/s, ↑0.00 MiB/s (0), ETA: 8.286s, {live: 1, queued: 0, dead: 0, known: 1}
// ETA is absent at zero speed. The arrows are matched as "any non-digit" so a
// terminal that mangles them still parses. Returns null for any other line.
var PROGRESS_RE = /\[(\d+)\]:\s+([\d.]+)%\s+\(([\d.]+\w*)\s*\/\s*([\d.]+\w*)\),\s*\D*?([\d.]+)\s*MiB\/s,\s*\D*?([\d.]+)\s*MiB\/s\s*\((\d+)\)(?:,\s*ETA:\s*([\d.]+)s)?,\s*\{live:\s*(\d+),\s*queued:\s*(\d+),\s*dead:\s*(\d+),\s*known:\s*(\d+)\}/;

function parseProgressLine(line) {
  var m = PROGRESS_RE.exec(String(line || ""));
  if (!m) return null;
  return {
    percent: parseFloat(m[2]),
    doneBytes: parseSize(m[3]),
    totalBytes: parseSize(m[4]),
    downMiBps: parseFloat(m[5]),
    upMiBps: parseFloat(m[6]),
    etaSecs: m[8] !== undefined ? parseFloat(m[8]) : null,
    peersLive: parseInt(m[9], 10),
    peersKnown: parseInt(m[12], 10)
  };
}

// `INFO librqbit::session: added torrent name="album"` → "album". This is the
// folder rqbit creates under the output dir, so it is where the files are.
function parseTorrentName(line) {
  var m = /added torrent name="((?:[^"\\]|\\.)*)"/.exec(String(line || ""));
  return m ? m[1].replace(/\\"/g, '"') : null;
}

// `-l` output → [{ name, sizeText, sizeBytes }]. Lines look like
//   INFO rqbit: File 01 - First Song.mp3, size 19.0Mi
// The name is everything between "File " and the LAST ", size " — a filename
// may itself contain ", size ".
function parseListOutput(stdout) {
  var out = [];
  var lines = String(stdout || "").split("\n");
  for (var i = 0; i < lines.length; i++) {
    var m = /INFO rqbit: File (.*)$/.exec(lines[i].replace(/\r$/, ""));
    if (!m) continue;
    var rest = m[1];
    var cut = rest.lastIndexOf(", size ");
    if (cut === -1) continue;
    var sizeText = rest.slice(cut + ", size ".length).trim();
    out.push({ name: rest.slice(0, cut), sizeText: sizeText, sizeBytes: parseSize(sizeText) });
  }
  return out;
}

// The user-facing reason from rqbit's output. rqbit reports the specific
// problem on an `error adding "<source>": <reason>` line and then a generic
// `error running rqbit: no torrents were added`; the first is the one worth
// showing. Multi-line causes ("Caused by:") are folded in.
function parseErrorMessage(stdout) {
  var text = String(stdout || "");
  var m = /ERROR rqbit: error adding "(?:[^"\\]|\\.)*":\s*(.*)$/m.exec(text);
  if (m) return m[1].trim();
  m = /ERROR rqbit: error running rqbit:\s*(.*)$/m.exec(text);
  if (m) return m[1].trim();
  m = /ERROR[^:]*:\s*(.*)$/m.exec(text);
  return m ? m[1].trim() : "";
}

// Did the run succeed? Exit 0 alone is not enough — `-l` exits 0 even after
// an "error adding" line — so success requires rqbit's own completion line.
function classifyOutcome(exitCode, stdout) {
  var text = String(stdout || "");
  if (exitCode === 0 && /All downloads completed/.test(text)) return { ok: true, message: "" };
  var reason = parseErrorMessage(text);
  if (/^cancelled$/i.test(reason)) return { ok: false, cancelled: true, message: "Cancelled", preexisting: false };
  if (!reason) reason = exitCode === 0 ? "rqbit exited without completing the download" : "rqbit exited with code " + exitCode;
  return { ok: false, cancelled: false, message: humanizeError(reason), preexisting: isPreexistingFilesError(reason) };
}

// rqbit's error strings are for its own users; a couple deserve a translation.
// rqbit refused to START because the destination already held these files.
// Nothing of ours was written, so cleanup must leave the folder alone — it is
// the user's existing album, not a failed download's leftovers.
function isPreexistingFilesError(reason) {
  return /File exists|allow_overwrite/i.test(String(reason || ""));
}

function humanizeError(reason) {
  var r = String(reason || "");
  if (/none of the filenames match/i.test(r)) return "No audio files in this torrent (the audio-only filter matched nothing). Turn the filter off in Settings → rqbit to download everything.";
  if (isPreexistingFilesError(r)) return "Files with these names already exist in the destination. Move them away, or download into another collection.";
  if (/no way to discover torrent metainfo/i.test(r)) return "Could not find any peer for this magnet link.";
  if (/error decoding torrent|invalid value/i.test(r)) return "That is not a valid .torrent file (the URL may have returned a web page instead).";
  if (/returned (\d{3})/i.test(r)) return "The .torrent URL could not be fetched (" + /returned (\d{3}[^"]*)/i.exec(r)[1].trim() + ").";
  return r;
}

function formatBytes(n) {
  if (typeof n !== "number" || !isFinite(n) || n < 0) return "";
  if (n >= 1024 * 1024 * 1024) return (n / 1024 / 1024 / 1024).toFixed(2) + " GB";
  if (n >= 1024 * 1024) return (n / 1024 / 1024).toFixed(1) + " MB";
  if (n >= 1024) return Math.round(n / 1024) + " KB";
  return n + " B";
}

function formatEta(secs) {
  if (typeof secs !== "number" || !isFinite(secs) || secs < 0) return "";
  secs = Math.round(secs);
  if (secs < 60) return secs + "s";
  if (secs < 3600) return Math.floor(secs / 60) + "m " + (secs % 60) + "s";
  return Math.floor(secs / 3600) + "h " + Math.floor((secs % 3600) / 60) + "m";
}

// One line of status for a job row — the same text the notification uses.
function jobStatusText(job, now) {
  now = now || Date.now();
  if (job.state === "done") return "Done · " + formatBytes(job.totalBytes) + (job.name ? " · in " + job.name : "");
  if (job.state === "failed") return "Failed — " + job.error + (job.cleaned ? " Partial files removed." : "");
  if (job.state === "cancelled") return "Cancelled" + (job.cleaned ? " · partial files removed" : "");
  if (job.state === "cancelling") return "Stopping…";
  if (job.state === "starting") {
    var waited = now - job.startedAt;
    if (waited > STUCK_AFTER_MS) return "No peers found after " + Math.round(waited / 60000) + " min — this magnet may be dead";
    return "Finding peers…";
  }
  var parts = [job.percent.toFixed(1) + "%"];
  if (job.totalBytes) parts.push(formatBytes(job.doneBytes) + " / " + formatBytes(job.totalBytes));
  if (job.downMiBps) parts.push("↓ " + job.downMiBps.toFixed(2) + " MiB/s");
  if (job.etaSecs != null) parts.push("ETA " + formatEta(job.etaSecs));
  parts.push(job.peersLive + " peer" + (job.peersLive === 1 ? "" : "s"));
  return parts.join(" · ");
}

// ---------------------------------------------------------------------------
// Settings persistence
// ---------------------------------------------------------------------------

function loadSettings() {
  return api.storage.get(STORAGE_KEY).then(function (s) {
    s = s || {};
    destCollectionId = s.destCollectionId ? String(s.destCollectionId) : "";
    audioOnly = s.audioOnly !== false;
  }).catch(function (e) {
    console.error("rqbit: could not read settings:", e);
  });
}

function saveSettings() {
  return api.storage.set(STORAGE_KEY, { destCollectionId: destCollectionId, audioOnly: audioOnly }).catch(function (e) {
    console.error("rqbit: could not save settings:", e);
    api.ui.showNotification("rqbit: could not save settings — " + errText(e));
  });
}

// ---------------------------------------------------------------------------
// Dependency + collections
// ---------------------------------------------------------------------------

function loadDependency() {
  if (!api.system || typeof api.system.getDependency !== "function") {
    rqbitDep = { installed: false, version: null, origin: null, hostTooOld: true };
    return Promise.resolve(rqbitDep);
  }
  return api.system.getDependency(DEP_NAME).then(function (d) {
    rqbitDep = d || { installed: false, version: null, origin: null };
    return rqbitDep;
  }).catch(function (e) {
    console.error("rqbit: dependency check failed:", e);
    rqbitDep = { installed: false, version: null, origin: null };
    return rqbitDep;
  });
}

function loadCollections() {
  if (!api.collections || typeof api.collections.getLocalCollections !== "function") return Promise.resolve([]);
  return api.collections.getLocalCollections().then(function (list) {
    localCollections = list || [];
    return localCollections;
  }).catch(function (e) {
    console.error("rqbit: could not read local collections:", e);
    return [];
  });
}

function collectionById(id) {
  for (var i = 0; i < localCollections.length; i++) {
    if (String(localCollections[i].id) === String(id)) return localCollections[i];
  }
  return null;
}

// Why a download can't start right now, or null when it can.
function readinessProblem() {
  if (!rqbitDep || !rqbitDep.installed) return "rqbit is not installed — install it from Settings → Dependencies.";
  var col = collectionById(destCollectionId);
  if (!col || !col.path) return "Choose the collection downloads should land in (Settings → rqbit).";
  return null;
}

// ---------------------------------------------------------------------------
// Jobs
// ---------------------------------------------------------------------------

function findJob(id) {
  for (var i = 0; i < jobs.length; i++) if (jobs[i].id === id) return jobs[i];
  return null;
}

function startJob(source) {
  source = String(source || "").trim();
  if (!isTorrentSource(source)) {
    api.ui.showNotification("rqbit: paste a magnet link, a .torrent URL or a .torrent file path.");
    return Promise.resolve(null);
  }
  var problem = readinessProblem();
  if (problem) {
    api.ui.showNotification("rqbit: " + problem);
    return Promise.resolve(null);
  }
  var col = collectionById(destCollectionId);
  var job = {
    id: "job-" + (++jobSeq),
    source: source,
    name: null, // rqbit's torrent name — the folder under outDir
    displayName: sourceDisplayName(source),
    outDir: col.path,
    collectionId: col.id,
    state: "starting", // starting | downloading | cancelling | done | failed | cancelled
    handle: null, // exec handle from opts.onStart — null on a host without it
    cleaned: false, // leftovers trashed via api.collections.trashPath
    percent: 0,
    doneBytes: 0,
    totalBytes: 0,
    downMiBps: 0,
    etaSecs: null,
    peersLive: 0,
    startedAt: Date.now(),
    finishedAt: null,
    lastLineAt: Date.now(),
    error: ""
  };
  jobs.unshift(job);
  renderView(true);
  api.log("info", "download " + job.displayName + " → " + job.outDir + (audioOnly ? " (audio only)" : ""), "rqbit");

  var args = buildDownloadArgs({ source: source, outDir: col.path, filenameRe: audioOnly ? AUDIO_FILE_RE : null });
  var onOutput = function (line) {
    job.lastLineAt = Date.now();
    var name = parseTorrentName(line);
    if (name) { job.name = name; renderView(); return; }
    var p = parseProgressLine(line);
    if (!p) return;
    job.state = "downloading";
    job.percent = p.percent;
    job.doneBytes = p.doneBytes || 0;
    job.totalBytes = p.totalBytes || job.totalBytes;
    job.downMiBps = p.downMiBps;
    job.etaSecs = p.etaSecs;
    job.peersLive = p.peersLive;
    renderView();
  };

  var execOpts = {
    cwd: null,
    onOutput: onOutput,
    onStart: function (handle) { job.handle = handle; renderView(true); }
  };
  return api.system.exec(DEP_NAME, args, execOpts).then(function (res) {
    var outcome = classifyOutcome(res.exitCode, res.stdout);
    job.finishedAt = Date.now();
    if (outcome.ok) {
      job.state = "done";
      job.percent = 100;
      api.log("info", "finished " + (job.name || job.displayName) + " (" + formatBytes(job.totalBytes) + ")", "rqbit");
      api.ui.showNotification("Downloaded " + (job.name || job.displayName));
      resyncCollection(job.collectionId);
      renderView(true);
      return job;
    }
    if (outcome.cancelled) {
      job.state = "cancelled";
    } else {
      job.state = "failed";
      job.error = outcome.message;
      api.log("warn", "failed " + job.displayName + " — " + outcome.message, "rqbit");
      api.ui.showNotification("rqbit: " + outcome.message);
    }
    renderView(true);
    return (outcome.preexisting ? Promise.resolve() : cleanupLeftovers(job)).then(function () { return job; });
  }).catch(function (e) {
    job.finishedAt = Date.now();
    var msg = errText(e);
    if (msg.trim() === "Cancelled") {
      job.state = "cancelled";
    } else {
      job.state = "failed";
      job.error = "rqbit could not be run — " + msg;
      console.error("rqbit: exec failed:", e);
      api.ui.showNotification("rqbit: " + job.error);
    }
    renderView(true);
    return cleanupLeftovers(job).then(function () { return job; });
  });
}

// Trash `<collection>/<torrent name>` after a failed or cancelled run. Only
// once rqbit told us the name (that line is logged as the torrent is added,
// which is when the files get created) — before that nothing was written.
function cleanupLeftovers(job) {
  if (!job.name) return Promise.resolve();
  if (!api.collections || typeof api.collections.trashPath !== "function") return Promise.resolve();
  return api.collections.trashPath(job.collectionId, job.name).then(function () {
    job.cleaned = true;
    api.log("info", "removed partial files of " + job.name, "rqbit");
    renderView(true);
  }).catch(function (e) {
    console.error("rqbit: could not remove partial files:", e);
    api.ui.showNotification("rqbit: could not remove the partial files of " + job.name + " — " + errText(e));
  });
}

function cancelJob(id) {
  var job = findJob(id);
  if (!job || !job.handle) return Promise.resolve();
  if (job.state !== "starting" && job.state !== "downloading") return Promise.resolve();
  job.state = "cancelling";
  renderView(true);
  api.log("info", "cancel " + (job.name || job.displayName), "rqbit");
  // The exec promise rejects with "Cancelled" and startJob's catch finishes the
  // job (state + cleanup); this only pulls the trigger.
  return job.handle.cancel().catch(function (e) {
    console.error("rqbit: cancel failed:", e);
    api.ui.showNotification("rqbit: could not stop the download — " + errText(e));
  });
}

// The files landed inside a local collection; a rescan is what makes them
// reach the library without waiting for the daily auto-update.
function resyncCollection(collectionId) {
  if (!api.collections || typeof api.collections.resync !== "function") return Promise.resolve();
  return api.collections.resync(collectionId).catch(function (e) {
    console.error("rqbit: collection rescan failed:", e);
    api.ui.showNotification("rqbit: the download finished but the collection could not be rescanned — use Resync in Collections.");
  });
}

function dismissJob(id) {
  for (var i = 0; i < jobs.length; i++) {
    if (jobs[i].id === id && jobs[i].state !== "starting" && jobs[i].state !== "downloading") {
      jobs.splice(i, 1);
      break;
    }
  }
  renderView(true);
}

function openJobFolder(id) {
  var job = findJob(id);
  if (!job || !api.system || typeof api.system.openPath !== "function") return;
  var path = job.outDir + (job.name ? "/" + job.name : "");
  api.system.openPath(path).catch(function (e) {
    console.error("rqbit: could not open folder:", e);
    api.ui.showNotification("rqbit: could not open " + path);
  });
}

// ---------------------------------------------------------------------------
// View
// ---------------------------------------------------------------------------

function jobNodes(job) {
  var children = [
    { type: "text", content: job.name || job.displayName, className: "title" },
    { type: "text", content: jobStatusText(job), className: job.state === "failed" ? "error" : "muted" }
  ];
  if (job.state === "downloading") {
    children.push({ type: "progress-bar", value: job.percent, max: 100 });
  } else if (job.state === "starting") {
    children.push({ type: "loading", message: "Connecting to peers" });
  }
  var buttons = [];
  var running = job.state === "starting" || job.state === "downloading";
  if (running && job.handle) {
    buttons.push({ label: "Cancel", action: "rqbit:cancel", data: { id: job.id }, variant: "secondary" });
  }
  if (job.state === "done" || ((job.state === "failed" || job.state === "cancelled") && !job.cleaned)) {
    buttons.push({ label: "Open folder", action: "rqbit:open", data: { id: job.id }, variant: "secondary" });
  }
  if (!running && job.state !== "cancelling") {
    buttons.push({ label: "Dismiss", action: "rqbit:dismiss", data: { id: job.id }, variant: "secondary" });
  }
  if ((job.state === "failed" || job.state === "cancelled") && job.name && !job.cleaned) {
    // rqbit preallocates files to full size before a byte arrives, so what a
    // failed run leaves behind looks complete. Only reached when the host has
    // no trashPath (older build) or the trash itself failed — say so, next to
    // the button that opens the place to clean up.
    children.push({
      type: "text",
      className: "ds-banner ds-banner--warning",
      content: "Partial files may be left in " + job.outDir + "/" + job.name + " — they are full-size but incomplete. Delete them before the next library scan."
    });
  }
  if (buttons.length) children.push({ type: "toolbar", buttons: buttons });
  return { type: "section", title: "", children: children };
}

function viewTree() {
  var children = [];
  var problem = readinessProblem();
  if (problem) {
    children.push({ type: "text", className: "ds-banner ds-banner--warning", content: problem });
  }
  children.push({
    type: "search-input",
    placeholder: "Paste a magnet link or .torrent URL",
    buttonLabel: "Download",
    pasteButton: true,
    action: "rqbit:add",
    stateKey: "add"
  });
  if (!jobs.length) {
    children.push({ type: "text", className: "muted", content: "Downloads run one at a time as their own rqbit process and stop when they finish. Files land in the collection chosen in Settings → rqbit and are scanned into your library automatically." });
  }
  for (var i = 0; i < jobs.length; i++) children.push(jobNodes(jobs[i]));
  return { type: "layout", direction: "vertical", children: children };
}

// Throttled: progress lines arrive once a second per job, and every call is
// a host re-render. `force` bypasses the throttle for state changes.
function renderView(force) {
  if (!api) return;
  var now = Date.now();
  if (!force && now - lastRenderAt < RENDER_THROTTLE_MS) {
    if (!renderTimer) {
      renderTimer = setTimeout(function () { renderTimer = null; renderView(true); }, RENDER_THROTTLE_MS - (now - lastRenderAt));
    }
    return;
  }
  lastRenderAt = now;
  api.ui.setViewData(VIEW_ID, viewTree(), { scrollKey: "main" });
}

// ---------------------------------------------------------------------------
// Settings panel
// ---------------------------------------------------------------------------

function destinationOptions() {
  var opts = [{ value: "", label: "Choose a collection…" }];
  for (var i = 0; i < localCollections.length; i++) {
    var c = localCollections[i];
    if (!c.path) continue;
    opts.push({ value: String(c.id), label: c.name + " — " + c.path });
  }
  return opts;
}

function settingsTree() {
  var dep = rqbitDep || {};
  var statusChildren = [
    {
      type: "stats-grid",
      items: [
        { label: "rqbit", value: dep.installed ? (dep.version || "installed") : "not installed" },
        { label: "Origin", value: dep.origin === "managed" ? "Managed by Viboplr" : dep.origin === "system" ? "System install" : "—" },
        { label: "Viboplr", value: api.appVersion || "?" }
      ]
    }
  ];
  if (dep.hostTooOld) {
    statusChildren.push({ type: "text", className: "ds-banner ds-banner--error", content: "This version of Viboplr cannot run rqbit — update the app." });
  } else if (!dep.installed) {
    statusChildren.push({ type: "text", className: "ds-banner ds-banner--warning", content: "Install rqbit from Settings → Dependencies (Viboplr downloads the official build for you), then come back here." });
  }
  statusChildren.push({ type: "toolbar", buttons: [{ label: "Re-check", action: "rqbit:recheck", variant: "secondary" }] });

  return {
    type: "layout",
    direction: "vertical",
    children: [
      { type: "section", title: "Status", children: statusChildren },
      {
        type: "section",
        title: "Downloads",
        children: [
          {
            type: "settings-row",
            label: "Destination collection",
            description: "Each torrent downloads into its own folder inside this collection, which is rescanned when it finishes.",
            control: { type: "select", action: "rqbit:set-dest", value: destCollectionId, options: destinationOptions() }
          },
          {
            type: "settings-row",
            label: "Audio files only",
            description: "Skip everything in a torrent that isn't music (cover scans, .nfo, sample videos). Off downloads the whole torrent.",
            control: { type: "toggle", label: "", action: "rqbit:set-audio-only", checked: !!audioOnly }
          }
        ]
      },
      {
        type: "section",
        title: "How it works",
        children: [
          { type: "text", className: "muted", content: "Every download is a separate rqbit process that exits when the torrent completes. Nothing runs in the background between downloads and nothing is seeded afterwards — if you need to keep seeding (private trackers), use the qBittorrent plugin instead." }
        ]
      }
    ]
  };
}

function renderSettings() {
  if (!api) return;
  api.ui.setViewData(SETTINGS_ID, settingsTree());
}

// ---------------------------------------------------------------------------
// Activation
// ---------------------------------------------------------------------------

function registerActions() {
  api.ui.onAction("rqbit:add", function (payload) {
    var q = payload && (payload.query != null ? payload.query : payload.value);
    return startJob(q);
  });
  api.ui.onAction("rqbit:dismiss", function (payload) { dismissJob(payload && payload.id); });
  api.ui.onAction("rqbit:cancel", function (payload) { return cancelJob(payload && payload.id); });
  api.ui.onAction("rqbit:open", function (payload) { openJobFolder(payload && payload.id); });
  api.ui.onAction("rqbit:recheck", function () {
    return Promise.all([loadDependency(), loadCollections()]).then(function () { renderSettings(); renderView(true); });
  });
  api.ui.onAction("rqbit:set-dest", function (payload) {
    destCollectionId = payload && payload.value != null ? String(payload.value) : "";
    return saveSettings().then(function () { renderSettings(); renderView(true); });
  });
  api.ui.onAction("rqbit:set-audio-only", function (payload) {
    audioOnly = !!(payload && (payload.checked != null ? payload.checked : payload.value));
    return saveSettings().then(function () { renderSettings(); });
  });
  // The Cmd+K no-match state hands the query to a tabbed view via host:search;
  // this view has a top-level search-input, so it is filled in by the host and
  // needs nothing here — but a pasted magnet through that route should still
  // start a download rather than sit in the box.
  api.ui.onAction("host:search", function (payload) {
    var q = payload && payload.query;
    if (isTorrentSource(q)) return startJob(q);
  });
}

async function activate(hostApi) {
  api = hostApi;
  registerActions();
  await Promise.all([loadSettings(), loadDependency(), loadCollections()]);
  renderSettings();
  renderView(true);
}

function deactivate() {
  if (renderTimer) { clearTimeout(renderTimer); renderTimer = null; }
  // Stop what we can: a disabled plugin must not leave rqbit processes running
  // that nothing will ever report on. A job without a handle (older host)
  // keeps going and lands in the collection as usual; the view just forgets it.
  for (var i = 0; i < jobs.length; i++) {
    var j = jobs[i];
    if (j.handle && (j.state === "starting" || j.state === "downloading")) {
      j.handle.cancel().catch(function (e) { console.error("rqbit: cancel on deactivate failed:", e); });
    }
  }
  jobs = [];
  api = null;
}

return {
  activate: activate,
  deactivate: deactivate,
  // Exposed for the test harness.
  _parseRqbitVersion: parseRqbitVersion,
  _isMagnet: isMagnet,
  _isTorrentSource: isTorrentSource,
  _infoHashOf: infoHashOf,
  _sourceDisplayName: sourceDisplayName,
  _buildDownloadArgs: buildDownloadArgs,
  _buildListArgs: buildListArgs,
  _parseSize: parseSize,
  _parseProgressLine: parseProgressLine,
  _parseTorrentName: parseTorrentName,
  _parseListOutput: parseListOutput,
  _parseErrorMessage: parseErrorMessage,
  _classifyOutcome: classifyOutcome,
  _humanizeError: humanizeError,
  _isPreexistingFilesError: isPreexistingFilesError,
  _formatBytes: formatBytes,
  _formatEta: formatEta,
  _jobStatusText: jobStatusText,
  _AUDIO_FILE_RE: AUDIO_FILE_RE,
  _RQBIT_GLOBAL_ARGS: RQBIT_GLOBAL_ARGS,
  _STUCK_AFTER_MS: STUCK_AFTER_MS
};
