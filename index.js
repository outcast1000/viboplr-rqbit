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
//  - Two ways a file leaves here. A WHOLE torrent (pasted magnet, a search
//    result's Download) is a job in the view, landing in the destination
//    collection. A SINGLE track (Pick tracks…, the Download… menu item, a
//    "Not in library" row) goes through the host's download modal: this
//    plugin is a download provider whose resolve IS the download — rqbit
//    fetches the one file into plugin storage and the resolve answers with its
//    file:// path (the yt-dlp shape). See "Download provider" below.
//  - Search is the qBittorrent plugin's web-indexer engine, ported verbatim
//    (selector engine, filters, bundled definitions) — a site fix there is a
//    definition fix here.

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

// The download provider, the stream-resolver entry that routes metadata-only
// downloads to it (see registerProviders), and the URI scheme the download
// modal hands back (see fileUri / findUri).
var PROVIDER_ID = "rqbit-download";
var PROVIDER_NAME = "rqbit";
var RESOLVER_ID = "rqbit-find";
var URI_SCHEME = "rqbit";

// Provider downloads land here (plugin storage), not in a collection: the
// modal copies the file to wherever the user chose. One folder per resolve.
var TMP_DIR = "tmp";
// Delivered folders kept around, so the modal can still be copying the last
// few files when the next resolve sweeps.
var TMP_KEEP_DELIVERED = 3;

// `-l` waits for the torrent's metadata from peers, and a dead magnet waits
// forever, silently — so a listing gets this long and no longer.
var LIST_TIMEOUT_MS = 45000;
// A provider download that hasn't even added its torrent by now never will.
var FETCH_META_TIMEOUT_MS = 90000;
// …and one whose bytes stop arriving for this long is not going to finish.
var FETCH_STALL_MS = 180000;

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
var lastViewHeader = null; // JSON of the last header sent (change gate)

// View: "search" (results, or one result's files) | "downloads" (jobs).
var activeTab = "search";
// The last search. `results` excludes notices, which live in `notices`.
var search = { query: "", running: false, ran: false, results: [], notices: [] };
var searchSeq = 0;
var sortBy = "seeders";
var sortDir = "desc";
// "Pick tracks…" on a result: null, or
// { resultId, title, state: "loading"|"ready"|"error", source, files, error, handle }.
var browse = null;

// Provider temp folders: in flight (never swept) and recently delivered.
var tmpInFlight = {};
var tmpDelivered = [];
var tmpSeq = 0;

// Settings (persisted).
var destCollectionId = "";
var audioOnly = true;
var disabledIndexers = {}; // { [defId]: true }

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

// Pure: the host-drawn header over the view (api.ui.setViewHeader). One status
// word says whether downloads can start; the subtitle says with what and where
// to. Why it can't start (and what to do) stays in the view's banner.
// `dep` is rqbitDep, `dest` the destination collection or null, `jobList` the
// jobs, `canOpen` whether the host can open a folder.
function viewHeaderFor(dep, dest, jobList, canOpen) {
  var active = 0;
  for (var i = 0; i < (jobList || []).length; i++) {
    var st = jobList[i].state;
    if (st === "starting" || st === "downloading" || st === "cancelling") active++;
  }
  var tagline = "Download music over BitTorrent into your library";
  if (!dep) return { subtitle: tagline, status: { variant: "muted", label: "Checking…" }, actions: [] };
  if (dep.hostTooOld) return { subtitle: tagline, status: { variant: "error", label: "Update Viboplr" }, actions: [] };
  if (!dep.installed) return { subtitle: tagline, status: { variant: "warning", label: "Not installed" }, actions: [] };
  var parts = ["rqbit " + (dep.version || "installed")];
  if (dest && dest.path) parts.push("into " + (dest.name || dest.path));
  if (active) parts.push(active + " downloading");
  var subtitle = parts.join(" · ");
  if (!dest || !dest.path) return { subtitle: subtitle, status: { variant: "warning", label: "No destination" }, actions: [] };
  var actions = canOpen ? [{ label: "Open folder", action: "rqbit:open-dest", variant: "secondary" }] : [];
  return {
    subtitle: subtitle,
    status: active ? { variant: "success", label: "Downloading" } : { variant: "success", label: "Ready" },
    actions: actions
  };
}

function delay(ms) {
  return new Promise(function (resolve) {
    setTimeout(resolve, ms);
  });
}

function numOr(v, fallback) {
  var n = Number(v);
  return isFinite(n) ? n : fallback;
}

// Indexers send -1 for "didn't report", and plenty omit the field entirely.
// Either way it is unknown, not zero — "0 seeders" is a verdict on the torrent.
function swarmCount(n) {
  if (n === null || n === undefined || n === "") return null;
  var v = Number(n);
  if (!isFinite(v) || v < 0) return null;
  return v;
}

// A failed indexer comes back from webSearchAll as ONE row with every number
// at -1 — the "notice" shape, rendered as a line under the results.
function isPluginNotice(r) {
  if (!r) return true;
  return Number(r.fileSize) < 0 && Number(r.nbSeeders) < 0 && Number(r.nbLeechers) < 0;
}

// Narration for search and hunts — the plugin log, so "why didn't it find it"
// is answerable from Report a problem.
function dbg(msg) {
  if (api) api.log("info", msg, "rqbit");
}

function formatAge(unixSeconds, nowMs) {
  var ts = numOr(unixSeconds, 0);
  if (ts <= 0) return "";
  var secs = Math.floor(((nowMs || Date.now()) - ts * 1000) / 1000);
  if (secs < 0) secs = 0;
  if (secs < 90) return "just now";
  var mins = Math.round(secs / 60);
  if (mins < 60) return mins + " min ago";
  var hours = Math.round(mins / 60);
  if (hours < 24) return hours === 1 ? "an hour ago" : hours + " hours ago";
  var days = Math.round(hours / 24);
  if (days < 30) return days === 1 ? "yesterday" : days + " days ago";
  var months = Math.round(days / 30);
  if (months < 12) return months === 1 ? "a month ago" : months + " months ago";
  var years = Math.round(months / 12);
  return years === 1 ? "a year ago" : years + " years ago";
}

// ---------------------------------------------------------------------------
// Track matching — which file in a torrent IS the wanted song
// ---------------------------------------------------------------------------
//
// Ported from viboplr-qbittorrent, where it was tuned for precision: a false
// positive downloads the WRONG song, which is strictly worse than finding
// nothing. A title alone never clears the threshold; the artist or the album
// must also appear somewhere around the file (its path or the torrent name).

// A torrent's paths are relative and may use either separator.
function baseName(name) {
  var rel = String(name || "").replace(/\\/g, "/");
  var parts = rel.split("/");
  return parts[parts.length - 1] || rel;
}

function extOf(name) {
  var m = /\.([A-Za-z0-9]{1,5})$/.exec(String(name || ""));
  return m ? m[1].toLowerCase() : null;
}

function isAudioFile(name) {
  return new RegExp(AUDIO_FILE_RE, "i").test(String(name || ""));
}

// Case-folded, diacritics-folded (Jóga == Joga), with release qualifiers
// stripped — "(Remastered 2015)" and "feat. …" say how a file was cut, not
// which song it is.
function normalizeForMatch(s) {
  var out = String(s == null ? "" : s).toLowerCase();
  if (typeof out.normalize === "function") {
    out = out.normalize("NFD").replace(/[̀-ͯ]/g, "");
  }
  out = out.replace(
    /[([][^)\]]*(remaster|deluxe|edition|version|mono|stereo|live|demo|bonus|anniversary|reissue|explicit|remix)[^)\]]*[)\]]/g,
    " "
  );
  out = out.replace(/\b(feat|ft|featuring)\.?\s.+$/g, " ");
  out = out.replace(/[^a-z0-9À-ɏͰ-ϿЀ-ӿ]+/g, " ");
  return out.replace(/\s+/g, " ").trim();
}

// Every token of `needle`, as a whole word, somewhere in the normalized `hay`.
// Whole words so "One" doesn't hide inside "Someone".
function containsAllTokens(hayNorm, needle) {
  var n = normalizeForMatch(needle);
  if (!n) return false;
  var hay = " " + hayNorm + " ";
  var toks = n.split(" ");
  for (var i = 0; i < toks.length; i++) {
    if (hay.indexOf(" " + toks[i] + " ") === -1) return false;
  }
  return true;
}

var MATCH_THRESHOLD = 0.7;

// Score one file against the wanted track: `cand` = { fileName, torrentName },
// `want` = { title, artist?, album? }. 0..1; only >= MATCH_THRESHOLD matches.
function titleMatchScore(cand, want) {
  if (!want || !want.title) return 0;
  var base = normalizeForMatch(baseName((cand && cand.fileName) || ""));
  var path = normalizeForMatch((cand && cand.fileName) || "");
  var torrent = normalizeForMatch((cand && cand.torrentName) || "");
  if (!containsAllTokens(base, want.title)) return 0;
  var artistEv = !!want.artist && (containsAllTokens(path, want.artist) || containsAllTokens(torrent, want.artist));
  var albumEv = !!want.album && (containsAllTokens(path, want.album) || containsAllTokens(torrent, want.album));
  // Title alone caps at half its weight — deliberately below the threshold.
  if (!artistEv && !albumEv) return 0.4;
  return Math.min(1, 0.8 * 0.7 + 0.2 + (artistEv && albumEv ? 0.05 : 0));
}

// The file inside a listed torrent that IS the wanted track, or null.
// `files` is parseListOutput's shape ({ name, sizeBytes }).
function pickFileForTrack(files, torrentName, want) {
  var best = null;
  var list = files || [];
  for (var i = 0; i < list.length; i++) {
    if (!isAudioFile(list[i].name)) continue;
    var score = titleMatchScore({ fileName: list[i].name, torrentName: torrentName }, want);
    if (score < MATCH_THRESHOLD) continue;
    // Equal scores: the bigger file — a FLAC over the MP3 of the same song in
    // a release that ships both.
    if (!best || score > best.score || (score === best.score && numOr(list[i].sizeBytes, 0) > numOr(best.file.sizeBytes, 0))) {
      best = { file: list[i], score: score };
    }
  }
  return best ? best.file : null;
}

// "03 - Artist - Title.flac" → { trackNumber: 3, artist: "Artist", title: "Title" }.
// What the download modal shows before the file's own tags are read.
function parseFileTrack(name) {
  var base = baseName(name).replace(/\.[A-Za-z0-9]{1,5}$/, "");
  var trackNumber = null;
  var m = /^\s*(\d{1,3})\s*[.\-_)]?\s+(.+)$/.exec(base);
  if (m) {
    trackNumber = parseInt(m[1], 10);
    base = m[2];
  }
  base = base.replace(/[_]+/g, " ").replace(/\s{2,}/g, " ").trim();
  var artist = null;
  var title = base;
  var dash = /^(.{1,60}?)\s+[-–—]\s+(.+)$/.exec(base);
  if (dash) {
    artist = dash[1].trim();
    title = dash[2].trim();
  }
  return { trackNumber: trackNumber, artist: artist || null, title: title || base };
}

// "Artist - Album (2001) [FLAC]" → { artist: "Artist", album: "Album" }. A
// release name is the only place a file inside it gets its artist from when
// the filename doesn't carry one. Bracketed qualifiers are dropped.
function parseReleaseName(name) {
  var s = String(name || "").replace(/[([{][^)\]}]*[)\]}]/g, " ").replace(/[_.]+/g, " ").replace(/\s{2,}/g, " ").trim();
  var dash = /^(.{1,80}?)\s+[-–—]\s+(.+)$/.exec(s);
  if (!dash) return { artist: null, album: s || null };
  return { artist: dash[1].trim() || null, album: dash[2].trim() || null };
}

// ---------------------------------------------------------------------------
// Finding a torrent for a track (the download provider's hunt)
// ---------------------------------------------------------------------------

var HUNT_MAX_CANDIDATES = 3;
var HUNT_MIN_SIZE = 5 * 1024 * 1024;
var HUNT_MAX_SIZE = 30 * 1024 * 1024 * 1024;

// What a torrent NAME says it holds. Video wins a tie on purpose: "Live At
// Wembley 1080p FLAC" is concert footage whose audio happens to be FLAC.
var VIDEO_TAGS = /(?:^|[^a-z0-9])(?:2160p|1440p|1080[pi]|720p|576p|480p|4k|8k|uhd|hdr|x26[45]|h ?\.?26[45]|hevc|avc|xvid|divx|blu-?ray|bdrip|brrip|bdremux|remux|web-?rip|hdtv|pdtv|dvd-?rip|dvd[59r]|hdrip|camrip|telesync|mkv|avi|webm|mp4|m4v|s\d{1,2}e\d{1,2})(?:[^a-z0-9]|$)/i;

function looksLikeVideo(name) {
  return VIDEO_TAGS.test(String(name || ""));
}

// The searches a hunt tries, in order. Releases are named by ARTIST and ALBUM,
// never by track title — so "artist album" leads, the artist alone follows
// (singles, EPs, releases named otherwise), and the bare title is used only
// when there is no artist to search by.
function discoveryQueries(want) {
  var artist = String((want && want.artist) || "").trim();
  var album = String((want && want.album) || "").trim();
  var title = String((want && want.title) || "").trim();
  var out = [];
  if (artist && album) out.push(artist + " " + album);
  if (artist) out.push(artist);
  if (!artist && title) out.push(title);
  return out;
}

// Hard filters, then a score: seeders are the availability FLOOR, not the
// ranking — the top-seeded result is routinely a 128k rip or a 400 GB
// discography. Format keywords, size sanity and a discography demotion do
// the rest.
function formatKeywordScore(name, format) {
  var n = String(name || "");
  var lossless = /\b(flac|alac|wav|lossless)\b/i.test(n);
  var cbr320 = /\b320\b/.test(n);
  var v0 = /\bv0\b/i.test(n);
  var hiRes = /\b24[\s-]?(bit|96|192)\b/i.test(n);
  var f = String(format || "").toLowerCase();
  if (f === "flac" || f === "alac" || f === "wav") {
    return (lossless ? 12 : 0) + (hiRes ? 4 : 0) + (cbr320 || /\bmp3\b/i.test(n) ? -4 : 0);
  }
  if (f === "mp3" || f === "aac" || f === "m4a" || f === "ogg" || f === "opus") {
    return (cbr320 ? 12 : 0) + (v0 ? 8 : 0) + (lossless ? 2 : 0);
  }
  return (lossless ? 6 : 0) + (cbr320 ? 4 : 0);
}

function scoreCandidate(r, ctx) {
  var s = 0;
  var seeds = swarmCount(r.nbSeeders);
  s += seeds === null ? 2 : Math.min(40, (4 * Math.log(1 + seeds)) / Math.LN2);
  var nameNorm = normalizeForMatch(r.fileName || "");
  if (ctx.album && containsAllTokens(nameNorm, ctx.album)) s += 15;
  if (ctx.title && containsAllTokens(nameNorm, ctx.title)) s += 6;
  s += formatKeywordScore(r.fileName, ctx.format);
  var size = numOr(r.fileSize, 0);
  if (size >= 50 * 1024 * 1024 && size <= 2 * 1024 * 1024 * 1024) s += 8;
  else if (size > 10 * 1024 * 1024 * 1024) s -= 8;
  if (/discograph|complete|collection|anthology|box\s?set/i.test(String(r.fileName || ""))) s -= 10;
  return s;
}

function rankCandidates(results, ctx) {
  var viable = [];
  var list = results || [];
  for (var i = 0; i < list.length; i++) {
    var r = list[i];
    if (!r || isPluginNotice(r) || !r.fileUrl) continue;
    if (looksLikeVideo(r.fileName)) continue;
    if (swarmCount(r.nbSeeders) === 0) continue; // dead; unknown passes
    var size = numOr(r.fileSize, 0);
    if (size > 0 && (size < HUNT_MIN_SIZE || size > HUNT_MAX_SIZE)) continue;
    if (ctx.artist && !containsAllTokens(normalizeForMatch(r.fileName || ""), ctx.artist)) continue;
    viable.push(r);
  }
  viable.sort(function (a, b) {
    var d = scoreCandidate(b, ctx) - scoreCandidate(a, ctx);
    if (d) return d;
    return numOr(b.nbLeechers, 0) - numOr(a.nbLeechers, 0);
  });
  return viable.slice(0, HUNT_MAX_CANDIDATES);
}

// What to search for on a thing the user right-clicked. An album is the
// useful unit — a track's own title finds single-track rips and misses the
// release it came from — so a track searches its ALBUM when it has one.
function searchQueryForTarget(target) {
  var t = target || {};
  var parts = t.kind === "artist" ? [t.artistName || t.title] : [t.artistName, t.albumTitle || t.title];
  var out = [];
  for (var i = 0; i < parts.length; i++) {
    var p = String(parts[i] == null ? "" : parts[i]).trim();
    if (p) out.push(p);
  }
  return out.join(" ").replace(/\s{2,}/g, " ").trim();
}

// ---------------------------------------------------------------------------
// rqbit:// URIs — what the download modal hands back to the provider
// ---------------------------------------------------------------------------
//
//   rqbit://file?src=<magnet|url>&path=<file path in the torrent>
//       one exact file — "Pick tracks…" in the view
//   rqbit://find?title=…&artist=…&album=…&duration=…
//       hunt for the track — the "Download…" context-menu item. Encoding the
//       hunt as a URI is what lets it run INSIDE the modal's resolve, where
//       progress is shown and Cancel kills rqbit; started anywhere else it
//       would be a minutes-long download with nobody watching.

function fileUri(source, path) {
  return URI_SCHEME + "://file?src=" + encodeURIComponent(String(source || "")) + "&path=" + encodeURIComponent(String(path || ""));
}

function findUri(want) {
  var parts = ["title=" + encodeURIComponent(String((want && want.title) || ""))];
  if (want && want.artist) parts.push("artist=" + encodeURIComponent(want.artist));
  if (want && want.album) parts.push("album=" + encodeURIComponent(want.album));
  if (want && numOr(want.durationSecs, 0) > 0) parts.push("duration=" + Math.round(want.durationSecs));
  return URI_SCHEME + "://find?" + parts.join("&");
}

function parseRqbitUri(uri) {
  var m = /^rqbit:\/\/(file|find)\?(.*)$/i.exec(String(uri || ""));
  if (!m) return null;
  var q = {};
  var pairs = m[2].split("&");
  for (var i = 0; i < pairs.length; i++) {
    var eq = pairs[i].indexOf("=");
    if (eq < 1) continue;
    try {
      q[pairs[i].slice(0, eq)] = decodeURIComponent(pairs[i].slice(eq + 1));
    } catch (e) {
      return null;
    }
  }
  if (m[1].toLowerCase() === "file") {
    if (!isTorrentSource(q.src) || !q.path) return null;
    return { kind: "file", source: q.src, path: q.path };
  }
  if (!q.title) return null;
  return {
    kind: "find",
    want: { title: q.title, artist: q.artist || "", album: q.album || "", durationSecs: numOr(q.duration, 0) }
  };
}

// `-r` matches the BASENAME against a regex; this one matches exactly one name.
function exactNameRe(name) {
  return "^" + String(name || "").replace(/[.*+?^${}()|[\]\\]/g, "\\$&") + "$";
}

// ---------------------------------------------------------------------------
// Web indexers — search torrent WEBSITES directly (Jackett-inspired)
//
// The idea borrowed from Jackett is indexers as DATA, not code: a JSON
// definition per site says how to build the search URL and how to read rows
// out of the response (JSON path, RSS tags, or CSS selectors over HTML).
// Ported from viboplr-qbittorrent (its web-indexer block is client-agnostic);
// a site fix there is a definition fix here too.
//
// The sandbox has no DOM — `document` is shadowed and DOMParser is off the
// sandbox contract — so HTML is parsed by the small tolerant parser below.
// It is NOT a browser parser and says so: no adoption agency (misnested
// <b><i></b></i>), no table foster-parenting, no <template>, no SVG/MathML
// foreign-content rules, no encodings beyond what the host already decoded.
// Tracker result tables don't need any of that; the auto-close rules cover
// the tag soup they actually serve.
// ---------------------------------------------------------------------------

// --- Markup parser ------------------------------------------------------------

var VOID_ELEMENTS = {
  area: 1, base: 1, br: 1, col: 1, embed: 1, hr: 1, img: 1, input: 1,
  link: 1, meta: 1, param: 1, source: 1, track: 1, wbr: 1
};
// Content is text until the matching close tag — a script containing the
// string "</table>" must not close the table.
var RAW_TEXT_ELEMENTS = { script: 1, style: 1, textarea: 1, title: 1 };
// Opening the KEY implicitly closes an open VALUE at the top of the stack,
// repeatedly. This is the whole tag-soup story for result tables: trackers
// routinely omit </td>, </tr> and </li>.
var AUTO_CLOSE = {
  li: { li: 1, p: 1 },
  p: { p: 1 },
  div: { p: 1 },
  table: { p: 1 },
  ul: { p: 1 },
  ol: { p: 1 },
  tr: { td: 1, th: 1, tr: 1 },
  td: { td: 1, th: 1 },
  th: { td: 1, th: 1 },
  thead: { td: 1, th: 1, tr: 1, tbody: 1, tfoot: 1, thead: 1 },
  tbody: { td: 1, th: 1, tr: 1, thead: 1, tfoot: 1, tbody: 1 },
  tfoot: { td: 1, th: 1, tr: 1, thead: 1, tbody: 1, tfoot: 1 },
  option: { option: 1 }
};

// The core five, matched case-insensitively (&AMP; is as valid as &amp;), plus
// nbsp folded to an ordinary space — a non-breaking space in a title is not
// something the list wants to preserve.
var NAMED_ENTITIES = { amp: "&", lt: "<", gt: ">", quot: "\"", apos: "'", nbsp: " " };

// The rest, as code points resolved on lookup — release names are littered with
// these (a dash is nearly always "&ndash;", and accented artists arrive as
// "&eacute;" from an HTML indexer that entity-escaped its output). Stored as
// numbers rather than literal glyphs so the source stays plain ASCII. Matched
// case-SENSITIVELY, because these entities are: &Eacute; is É, &eacute; é.
var NAMED_ENTITY_CODES = {
  // Punctuation & typography.
  ndash: 8211, mdash: 8212, hellip: 8230, lsquo: 8216, rsquo: 8217, sbquo: 8218,
  ldquo: 8220, rdquo: 8221, bdquo: 8222, dagger: 8224, Dagger: 8225, bull: 8226,
  prime: 8242, Prime: 8243, lsaquo: 8249, rsaquo: 8250, oline: 8254, frasl: 8260,
  permil: 8240,
  // Symbols & Latin-1 punctuation.
  iexcl: 161, cent: 162, pound: 163, curren: 164, yen: 165, brvbar: 166, sect: 167,
  uml: 168, copy: 169, ordf: 170, laquo: 171, not: 172, shy: 173, reg: 174, macr: 175,
  deg: 176, plusmn: 177, sup2: 178, sup3: 179, acute: 180, micro: 181, para: 182,
  middot: 183, cedil: 184, sup1: 185, ordm: 186, raquo: 187, frac14: 188, frac12: 189,
  frac34: 190, iquest: 191, times: 215, divide: 247, euro: 8364, trade: 8482,
  // Accented Latin, upper then lower.
  Agrave: 192, Aacute: 193, Acirc: 194, Atilde: 195, Auml: 196, Aring: 197, AElig: 198,
  Ccedil: 199, Egrave: 200, Eacute: 201, Ecirc: 202, Euml: 203, Igrave: 204, Iacute: 205,
  Icirc: 206, Iuml: 207, ETH: 208, Ntilde: 209, Ograve: 210, Oacute: 211, Ocirc: 212,
  Otilde: 213, Ouml: 214, Oslash: 216, Ugrave: 217, Uacute: 218, Ucirc: 219, Uuml: 220,
  Yacute: 221, THORN: 222, szlig: 223,
  agrave: 224, aacute: 225, acirc: 226, atilde: 227, auml: 228, aring: 229, aelig: 230,
  ccedil: 231, egrave: 232, eacute: 233, ecirc: 234, euml: 235, igrave: 236, iacute: 237,
  icirc: 238, iuml: 239, eth: 240, ntilde: 241, ograve: 242, oacute: 243, ocirc: 244,
  otilde: 245, ouml: 246, oslash: 248, ugrave: 249, uacute: 250, ucirc: 251, uuml: 252,
  yacute: 253, thorn: 254, yuml: 255
};

function decodeEntities(s) {
  var str = String(s == null ? "" : s);
  if (str.indexOf("&") === -1) return str;
  return str.replace(/&(#[xX]?[0-9a-fA-F]+|[a-zA-Z][a-zA-Z0-9]*);/g, function (whole, body) {
    if (body.charAt(0) === "#") {
      var hex = body.charAt(1) === "x" || body.charAt(1) === "X";
      var code = parseInt(body.substring(hex ? 2 : 1), hex ? 16 : 10);
      // No surrogate pairs — an astral emoji entity in a torrent name
      // degrades to the raw entity text, which is fine.
      return isFinite(code) && code > 0 && code < 0xffff ? String.fromCharCode(code) : whole;
    }
    // Case-insensitive for the core five; exact-case for the code table, whose
    // entries genuinely differ by case.
    var lower = body.toLowerCase();
    if (Object.prototype.hasOwnProperty.call(NAMED_ENTITIES, lower)) return NAMED_ENTITIES[lower];
    if (Object.prototype.hasOwnProperty.call(NAMED_ENTITY_CODES, body)) {
      return String.fromCharCode(NAMED_ENTITY_CODES[body]);
    }
    return whole;
  });
}

// Parse HTML (htmlMode) or XML/RSS (!htmlMode) into a tree of
// { tag, attrs, children, parent } elements and { text, parent } text nodes.
// `parent` pointers exist for the selector combinators — a node is NOT
// JSON-serializable.
function parseMarkup(text, htmlMode) {
  var src = String(text == null ? "" : text);
  var root = { tag: "#root", attrs: {}, children: [], parent: null };
  var stack = [root];
  var i = 0;
  var n = src.length;

  var top = function () {
    return stack[stack.length - 1];
  };
  var addText = function (raw, skipDecode) {
    if (!raw) return;
    top().children.push({ text: skipDecode ? raw : decodeEntities(raw), parent: top() });
  };

  while (i < n) {
    var lt = src.indexOf("<", i);
    if (lt === -1) {
      addText(src.substring(i));
      break;
    }
    if (lt > i) addText(src.substring(i, lt));

    if (src.substr(lt, 4) === "<!--") {
      var endComment = src.indexOf("-->", lt + 4);
      i = endComment === -1 ? n : endComment + 3;
      continue;
    }
    if (src.substr(lt, 9) === "<![CDATA[") {
      var endCdata = src.indexOf("]]>", lt + 9);
      addText(src.substring(lt + 9, endCdata === -1 ? n : endCdata), true);
      i = endCdata === -1 ? n : endCdata + 3;
      continue;
    }
    var next = src.charAt(lt + 1);
    if (next === "!" || next === "?") {
      var endDecl = src.indexOf(">", lt + 1);
      i = endDecl === -1 ? n : endDecl + 1;
      continue;
    }
    if (next === "/") {
      var endClose = src.indexOf(">", lt + 2);
      var closeName = src
        .substring(lt + 2, endClose === -1 ? n : endClose)
        .replace(/[\s/].*$/, "")
        .toLowerCase();
      if (closeName) {
        // Pop to the nearest matching open tag anywhere in the stack (closing
        // everything in between); a close nothing opened is ignored.
        for (var s = stack.length - 1; s >= 1; s--) {
          if (stack[s].tag === closeName) {
            stack.length = s;
            break;
          }
        }
      }
      i = endClose === -1 ? n : endClose + 1;
      continue;
    }
    if (!/[a-zA-Z]/.test(next)) {
      // A bare "<" in text ("<3 seeders") is text, not markup.
      addText("<");
      i = lt + 1;
      continue;
    }

    // Opening tag: name, then attributes in their quoting variants.
    var j = lt + 1;
    while (j < n && /[^\s/>]/.test(src.charAt(j))) j++;
    var tag = src.substring(lt + 1, j).toLowerCase();
    var attrs = {};
    var selfClosed = false;
    while (j < n) {
      while (j < n && /\s/.test(src.charAt(j))) j++;
      var ch = src.charAt(j);
      if (ch === ">") {
        j++;
        break;
      }
      if (ch === "/") {
        if (src.charAt(j + 1) === ">") {
          selfClosed = true;
          j += 2;
          break;
        }
        j++;
        continue;
      }
      if (j >= n) break;
      var nameStart = j;
      while (j < n && /[^\s=/>]/.test(src.charAt(j))) j++;
      var attrName = src.substring(nameStart, j).toLowerCase();
      while (j < n && /\s/.test(src.charAt(j))) j++;
      var attrValue = "";
      if (src.charAt(j) === "=") {
        j++;
        while (j < n && /\s/.test(src.charAt(j))) j++;
        var quote = src.charAt(j);
        if (quote === "\"" || quote === "'") {
          var endQuote = src.indexOf(quote, j + 1);
          attrValue = src.substring(j + 1, endQuote === -1 ? n : endQuote);
          j = endQuote === -1 ? n : endQuote + 1;
        } else {
          var valueStart = j;
          while (j < n && /[^\s>]/.test(src.charAt(j))) j++;
          attrValue = src.substring(valueStart, j);
        }
      }
      if (attrName) attrs[attrName] = decodeEntities(attrValue);
    }
    i = j;

    if (htmlMode) {
      var closes = AUTO_CLOSE[tag];
      while (closes && stack.length > 1 && closes[top().tag]) stack.pop();
    }
    var el = { tag: tag, attrs: attrs, children: [], parent: top() };
    top().children.push(el);
    var isVoid = htmlMode && VOID_ELEMENTS[tag];
    if (!selfClosed && !isVoid) stack.push(el);

    if (htmlMode && RAW_TEXT_ELEMENTS[tag] && !selfClosed) {
      var closeRe = new RegExp("</" + tag + "[\\s>]", "i");
      var match = closeRe.exec(src.substring(i));
      var rawEnd = match ? i + match.index : n;
      if (rawEnd > i) el.children.push({ text: src.substring(i, rawEnd), parent: el });
      if (match) {
        var gt = src.indexOf(">", rawEnd);
        i = gt === -1 ? n : gt + 1;
      } else {
        i = n;
      }
      stack.pop();
    }
  }
  return root;
}

// Concatenated descendant text, whitespace collapsed. What "the cell says".
function nodeText(node) {
  if (!node) return "";
  if (node.text !== undefined) return String(node.text).replace(/\s+/g, " ").trim();
  var out = [];
  var walk = function (nd) {
    var kids = nd.children || [];
    for (var i = 0; i < kids.length; i++) {
      if (kids[i].text !== undefined) out.push(kids[i].text);
      else walk(kids[i]);
    }
  };
  walk(node);
  return out.join("").replace(/\s+/g, " ").trim();
}

// --- Selector engine ------------------------------------------------------------
//
// The supported subset, chosen by what the bundled definitions need and
// nothing more: tag, .class, #id, [attr], [attr=v], [attr^=v], [attr*=v],
// compounds, descendant (space), child (>), :nth-child(n). Anything else is
// an ERROR, not a silent mismatch — the parser doubles as the definition
// validator, so a user pasting ":not(...)" is told exactly what isn't
// supported.

function parseSelector(sel) {
  var s = String(sel == null ? "" : sel).trim();
  if (!s) return { error: "empty selector" };
  var steps = [];
  var i = 0;
  var n = s.length;
  var pendingComb = " ";
  while (i < n) {
    var step = { combinator: pendingComb, tag: "", id: "", classes: [], attrs: [], nth: 0 };
    var compoundStart = i;
    var tagStart = i;
    // No ":" in tag names — a namespaced RSS tag (nyaa:seeders) is reached via
    // childByTag(), never a selector, and letting ":" into the name here would
    // silently swallow ":nth-child" and every unsupported pseudo.
    while (i < n && /[a-zA-Z0-9_*-]/.test(s.charAt(i))) i++;
    if (i > tagStart) {
      var tagName = s.substring(tagStart, i);
      if (tagName !== "*") step.tag = tagName.toLowerCase();
    }
    var simpleLoop = true;
    while (simpleLoop && i < n) {
      var ch = s.charAt(i);
      if (ch === ".") {
        i++;
        var classStart = i;
        while (i < n && /[a-zA-Z0-9_-]/.test(s.charAt(i))) i++;
        if (i === classStart) return { error: "empty class name in “" + sel + "”" };
        step.classes.push(s.substring(classStart, i));
      } else if (ch === "#") {
        i++;
        var idStart = i;
        while (i < n && /[a-zA-Z0-9_-]/.test(s.charAt(i))) i++;
        if (i === idStart) return { error: "empty id in “" + sel + "”" };
        step.id = s.substring(idStart, i);
      } else if (ch === "[") {
        var closeBracket = s.indexOf("]", i);
        if (closeBracket === -1) return { error: "unclosed [ in “" + sel + "”" };
        var body = s.substring(i + 1, closeBracket);
        i = closeBracket + 1;
        var attrMatch = /^([a-zA-Z0-9_:-]+)\s*(?:([\^*]?=)\s*(.*))?$/.exec(body);
        if (!attrMatch) return { error: "unsupported attribute selector “[" + body + "]” in “" + sel + "”" };
        var rawValue = attrMatch[3] === undefined ? null : attrMatch[3].replace(/^["']/, "").replace(/["']$/, "");
        step.attrs.push({ name: attrMatch[1].toLowerCase(), op: attrMatch[2] || "", value: rawValue });
      } else if (ch === ":") {
        var nthMatch = /^:nth-child\((\d+)\)/.exec(s.substring(i));
        if (!nthMatch) return { error: "unsupported selector feature “" + s.substring(i, i + 12) + "…” in “" + sel + "”" };
        step.nth = parseInt(nthMatch[1], 10);
        i += nthMatch[0].length;
      } else if (ch === "," || ch === "+" || ch === "~") {
        return { error: "unsupported selector feature “" + ch + "” in “" + sel + "”" };
      } else {
        simpleLoop = false;
      }
    }
    if (i === compoundStart) return { error: "could not parse “" + sel + "”" };
    steps.push(step);
    // Between compounds: whitespace = descendant, ">" = child.
    var sawWs = false;
    while (i < n && /\s/.test(s.charAt(i))) {
      i++;
      sawWs = true;
    }
    if (i < n && s.charAt(i) === ">") {
      pendingComb = ">";
      i++;
      while (i < n && /\s/.test(s.charAt(i))) i++;
    } else if (sawWs) {
      pendingComb = " ";
    } else if (i < n) {
      return { error: "could not parse “" + sel + "” near “" + s.substring(i, i + 8) + "”" };
    }
  }
  if (!steps.length) return { error: "empty selector" };
  return { steps: steps };
}

function matchesStep(el, step) {
  if (!el || el.text !== undefined || el.tag === "#root") return false;
  if (step.tag && el.tag !== step.tag) return false;
  if (step.id && el.attrs.id !== step.id) return false;
  for (var c = 0; c < step.classes.length; c++) {
    var classes = " " + (el.attrs["class"] || "") + " ";
    if (classes.indexOf(" " + step.classes[c] + " ") === -1) return false;
  }
  for (var a = 0; a < step.attrs.length; a++) {
    var spec = step.attrs[a];
    var val = el.attrs[spec.name];
    if (val === undefined) return false;
    if (spec.value !== null) {
      if (spec.op === "=" && val !== spec.value) return false;
      if (spec.op === "^=" && val.indexOf(spec.value) !== 0) return false;
      if (spec.op === "*=" && val.indexOf(spec.value) === -1) return false;
    }
  }
  if (step.nth) {
    var parent = el.parent;
    if (!parent) return false;
    var position = 0;
    var kids = parent.children;
    for (var k = 0; k < kids.length; k++) {
      if (kids[k].text !== undefined) continue;
      position++;
      if (kids[k] === el) break;
    }
    if (position !== step.nth) return false;
  }
  return true;
}

// Verify the left part of the chain for an element that matched the rightmost
// compound. Descendant combinators backtrack up the ancestor list.
function matchesChain(el, steps, stepIdx) {
  if (stepIdx === 0) return true;
  var prev = steps[stepIdx - 1];
  if (steps[stepIdx].combinator === ">") {
    var parent = el.parent;
    return !!(parent && matchesStep(parent, prev) && matchesChain(parent, steps, stepIdx - 1));
  }
  var anc = el.parent;
  while (anc) {
    if (matchesStep(anc, prev) && matchesChain(anc, steps, stepIdx - 1)) return true;
    anc = anc.parent;
  }
  return false;
}

function selectAll(root, selector) {
  var parsed = typeof selector === "string" ? parseSelector(selector) : selector;
  if (!parsed || parsed.error || !root) return [];
  var steps = parsed.steps;
  var last = steps.length - 1;
  var out = [];
  var walk = function (node) {
    var kids = node.children || [];
    for (var i = 0; i < kids.length; i++) {
      var el = kids[i];
      if (el.text !== undefined) continue;
      if (matchesStep(el, steps[last]) && matchesChain(el, steps, last)) out.push(el);
      walk(el);
    }
  };
  walk(root);
  return out;
}

function selectFirst(root, selector) {
  var all = selectAll(root, selector);
  return all.length ? all[0] : null;
}

// First DIRECT child element with this tag name — the RSS field accessor
// (handles namespaced names like "nyaa:seeders", which selectors refuse).
function childByTag(el, tagName) {
  var name = String(tagName || "").toLowerCase();
  var kids = (el && el.children) || [];
  for (var i = 0; i < kids.length; i++) {
    if (kids[i].text === undefined && kids[i].tag === name) return kids[i];
  }
  return null;
}

// --- Value filters ------------------------------------------------------------

// "1.4 GB" / "1,4 Go" / "1.234,5 MB" / "1,234.5 MiB" → bytes. The LAST of
// "."/"," present is the decimal separator; the other is thousands noise.
// KB/KiB/Ko variants are used interchangeably by indexers, so everything is
// 1024-based — the value only feeds display and sorting.
function parseHumanSize(s) {
  var str = String(s == null ? "" : s).replace(/\u00a0/g, " ").trim();
  var m = /^([\d.,\s]+?)\s*([kmgt]?i?[bo])\b/i.exec(str);
  var numPart;
  var unitChar;
  if (m) {
    numPart = m[1];
    unitChar = m[2].toLowerCase().charAt(0);
  } else if (/^[\d.,\s]+$/.test(str) && str.length) {
    numPart = str;
    unitChar = "b";
  } else {
    return null;
  }
  var num = numPart.replace(/\s+/g, "");
  var lastDot = num.lastIndexOf(".");
  var lastComma = num.lastIndexOf(",");
  if (lastDot > lastComma) num = num.replace(/,/g, "");
  else if (lastComma > -1) num = num.replace(/\./g, "").replace(",", ".");
  var value = parseFloat(num);
  if (!isFinite(value) || value < 0) return null;
  var mult =
    unitChar === "k" ? 1024
      : unitChar === "m" ? 1048576
        : unitChar === "g" ? 1073741824
          : unitChar === "t" ? 1099511627776
            : 1;
  return Math.round(value * mult);
}

// A date string from wherever an indexer keeps one → unix SECONDS, the shape
// formatAge wants. Sources vary wildly and this has to swallow all of them:
// apibay ships raw unix seconds ("1363971375"); nyaa an RFC-822 pubDate; rargb
// "2026-08-08 09:06:09"; bitsearch "2/22/2024"; 1337x the ugliest, "Mar. 3rd
// '18" — an abbreviated month, an ordinal suffix, and a two-digit year. null
// for anything unrecognisable, so a stale-format column reads "—" rather than
// a wrong date. Local-timezone for the bare datetime forms, which is fine for
// a coarse "added" column that formatAge rounds to days anyway.
function parseDate(v) {
  var s = String(v == null ? "" : v).trim();
  if (!s) return null;
  // Already a unix timestamp — 10 digits is seconds, 13 is milliseconds.
  if (/^\d{9,14}$/.test(s)) {
    var n = parseInt(s, 10);
    if (s.length >= 13) n = Math.floor(n / 1000);
    return n > 0 ? n : null;
  }
  // Normalise the human forms Date.parse won't take: "3rd" → "3", "'18" → 2018.
  var norm = s.replace(/(\d)(st|nd|rd|th)\b/gi, "$1").replace(/'(\d{2})\b/g, "20$1");
  var t = Date.parse(norm);
  // A trailing period on an abbreviated month ("Mar.") defeats some engines.
  if (isNaN(t)) t = Date.parse(norm.replace(/\./g, ""));
  if (isNaN(t)) return null;
  var secs = Math.floor(t / 1000);
  return secs > 0 ? secs : null;
}

var KNOWN_FILTERS = { trim: 1, regex: 2, parseSize: 1, parseInt: 1, parseDate: 1, prepend: 2, append: 2, querystring: 2, replace: 3 };

function applyFilters(value, filters) {
  var v = value == null ? "" : value;
  var list = filters || [];
  for (var i = 0; i < list.length; i++) {
    var f = list[i];
    var name = f && f[0];
    if (name === "trim") v = String(v).trim();
    else if (name === "regex") {
      var rm = new RegExp(f[1]).exec(String(v));
      v = rm ? (rm[1] !== undefined ? rm[1] : rm[0]) : "";
    } else if (name === "parseSize") v = parseHumanSize(v);
    else if (name === "parseDate") v = parseDate(v);
    else if (name === "parseInt") {
      var cleaned = String(v)
        .replace(/[\s\u00a0]/g, "")
        .replace(/[.,](?=\d{3}(\D|$))/g, "");
      var parsed = parseInt(cleaned, 10);
      v = isNaN(parsed) ? null : parsed;
    } else if (name === "prepend") v = String(f[1]) + String(v);
    else if (name === "append") v = String(v) + String(f[1]);
    else if (name === "querystring") {
      var escaped = String(f[1]).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      var qm = new RegExp("[?&]" + escaped + "=([^&#]*)").exec(String(v));
      v = qm ? decodeURIComponent(qm[1].replace(/\+/g, " ")) : "";
    } else if (name === "replace") v = String(v).split(String(f[1])).join(String(f[2]));
    // Unknown names are rejected by validateIndexerDef; at runtime they are
    // skipped so one bad custom def degrades instead of throwing mid-sweep.
  }
  return v;
}

// --- Indexer definitions & engine ----------------------------------------------

var WEB_TIMEOUT_MS = 10000;
var WEB_MIN_GAP_MS = 2500;
var WEB_GAP_JITTER_MS = 500;
var WEB_DEF_ROW_CAP = 50;
var WEB_TOTAL_ROW_CAP = 150;

// Dot-path into a JSON value; "" is the value itself. Deliberately tiny — no
// wildcards, no arrays-in-the-middle; nothing the bundled defs need.
function jsonPath(value, path) {
  var p = String(path == null ? "" : path);
  if (!p) return value;
  var parts = p.split(".");
  var v = value;
  for (var i = 0; i < parts.length; i++) {
    if (v == null || typeof v !== "object") return undefined;
    v = v[parts[i]];
  }
  return v;
}

function buildSearchUrl(def, query) {
  return String(def.search.url).replace("{q}", encodeURIComponent(String(query == null ? "" : query)));
}

// magnet:?xt=urn:btih:… from a JSON row. Returns null for anything that is
// not a real 40-hex hash — apibay answers an EMPTY search with one sentinel
// row whose hash is all zeros, and without this rule every empty TPB search
// would produce a fake addable result.
function buildMagnet(infoHash, name, trackers) {
  var hash = String(infoHash == null ? "" : infoHash).trim().toLowerCase();
  if (!/^[0-9a-f]{40}$/.test(hash)) return null;
  if (/^0{40}$/.test(hash)) return null;
  var out = "magnet:?xt=urn:btih:" + hash;
  if (name) out += "&dn=" + encodeURIComponent(String(name));
  var list = trackers || [];
  for (var i = 0; i < list.length; i++) out += "&tr=" + encodeURIComponent(String(list[i]));
  return out;
}

// Extract one field from one row per the def type. Returns the raw string
// (before filters); "" when the source finds nothing.
function extractField(spec, row, defType) {
  if (defType === "json") {
    var v = jsonPath(row, spec.path);
    return v == null ? "" : String(v);
  }
  if (defType === "rss") {
    var child = childByTag(row, spec.tag);
    return child ? nodeText(child) : "";
  }
  var el = spec.selector ? selectFirst(row, spec.selector) : row;
  if (!el) return "";
  if (spec.attribute) {
    var attr = el.attrs && el.attrs[String(spec.attribute).toLowerCase()];
    return attr == null ? "" : attr;
  }
  return nodeText(el);
}

// Run one definition against a RESPONSE BODY — pure, no network, which is what
// makes every bundled def testable against a saved fixture. Returns result
// rows in the plugin's standard search shape.
function runDefOnBody(def, bodyText) {
  var rows;
  if (def.type === "json") {
    var parsed = JSON.parse(bodyText);
    var arr = jsonPath(parsed, (def.rows && def.rows.path) || "");
    rows = Object.prototype.toString.call(arr) === "[object Array]" ? arr : [];
  } else if (def.type === "rss") {
    rows = selectAll(parseMarkup(bodyText, false), (def.rows && def.rows.tag) || "item");
  } else {
    rows = selectAll(parseMarkup(bodyText, true), def.rows.selector);
  }
  var cap = Math.min(rows.length, def.limit || WEB_DEF_ROW_CAP);
  var out = [];
  for (var i = 0; i < cap; i++) {
    var mapped = mapDefRow(def, rows[i]);
    if (mapped) out.push(mapped);
  }
  return out;
}

function mapDefRow(def, row) {
  var fields = def.fields || {};
  var result = { siteUrl: def.siteUrl, engineName: "web:" + def.id };
  // nbFiles is optional and rare — apibay reports it, an HTML scrape almost
  // never does, and qBittorrent's own search API has no such field at all. A
  // row without it says "—" in the Files column rather than "0": the only
  // honest alternative would be adding the torrent and fetching its metadata,
  // which a search result must not do.
  var names = ["fileName", "fileUrl", "fileSize", "nbFiles", "added", "nbSeeders", "nbLeechers", "descrLink"];
  for (var i = 0; i < names.length; i++) {
    var key = names[i];
    var spec = fields[key];
    if (!spec) continue;
    var value;
    if (key === "fileUrl" && spec.magnet) {
      value = buildMagnet(
        extractField(spec.magnet.infoHash, row, def.type),
        spec.magnet.name ? extractField(spec.magnet.name, row, def.type) : "",
        spec.magnet.trackers
      );
      if (value === null) return null; // sentinel / junk hash — drop the row
    } else {
      value = applyFilters(extractField(spec, row, def.type), spec.filters);
    }
    // Unknown numbers stay ABSENT, never -1: a row with -1 size and -1 swarm
    // is the isPluginNotice shape and would render as an engine error.
    if (key === "fileSize" || key === "nbFiles" || key === "added" || key === "nbSeeders" || key === "nbLeechers") {
      if (typeof value === "number" && isFinite(value) && value >= 0) result[key] = value;
    } else if (value) {
      result[key] = String(value);
    }
  }
  if (!result.fileName) return null;
  if (!result.fileUrl) {
    // Magnet-on-detail-page defs: the row ships its detail URL as fileUrl so
    // identity and the add flow have something stable, tagged for the lazy
    // magnet resolution at add time (resolveWebFileUrl).
    if (def.magnetFollow && result.descrLink) {
      result.fileUrl = result.descrLink;
      result.webFollow = def.id;
    } else {
      return null;
    }
  }
  return result;
}

// --- Bundled definitions --------------------------------------------------------
//
// Data, not code. Selectors are pinned by the fixture tests; when a site
// redesigns, the fix is a new definition, not a new parser.

var WEB_DEFS = [
  {
    schemaVersion: 1,
    id: "tpb",
    name: "The Pirate Bay",
    siteUrl: "https://thepiratebay.org",
    type: "json",
    search: { url: "https://apibay.org/q.php?q={q}&cat=100" },
    rows: { path: "" },
    fields: {
      fileName: { path: "name" },
      fileUrl: {
        magnet: {
          infoHash: { path: "info_hash" },
          name: { path: "name" },
          trackers: [
            "udp://tracker.opentrackr.org:1337/announce",
            "udp://open.stealth.si:80/announce",
            "udp://tracker.torrent.eu.org:451/announce",
            "udp://exodus.desync.com:6969/announce"
          ]
        }
      },
      fileSize: { path: "size", filters: [["parseInt"]] },
      nbFiles: { path: "num_files", filters: [["parseInt"]] },
      added: { path: "added", filters: [["parseDate"]] },
      nbSeeders: { path: "seeders", filters: [["parseInt"]] },
      nbLeechers: { path: "leechers", filters: [["parseInt"]] },
      descrLink: { path: "id", filters: [["prepend", "https://thepiratebay.org/description.php?id="]] }
    }
  },
  {
    schemaVersion: 1,
    id: "nyaa",
    name: "Nyaa",
    siteUrl: "https://nyaa.si",
    type: "rss",
    search: { url: "https://nyaa.si/?page=rss&q={q}&c=2_0&f=0" },
    rows: { tag: "item" },
    fields: {
      fileName: { tag: "title" },
      fileUrl: { tag: "link" },
      fileSize: { tag: "nyaa:size", filters: [["parseSize"]] },
      added: { tag: "pubDate", filters: [["parseDate"]] },
      nbSeeders: { tag: "nyaa:seeders", filters: [["parseInt"]] },
      nbLeechers: { tag: "nyaa:leechers", filters: [["parseInt"]] },
      descrLink: { tag: "guid" }
    }
  },
  {
    schemaVersion: 1,
    id: "x1337",
    name: "1337x",
    siteUrl: "https://1337x.to",
    type: "html",
    search: { url: "https://1337x.to/category-search/{q}/Music/1/" },
    rows: { selector: "table.table-list tbody > tr" },
    fields: {
      fileName: { selector: "td.coll-1 a:nth-child(2)" },
      descrLink: { selector: "td.coll-1 a:nth-child(2)", attribute: "href", filters: [["prepend", "https://1337x.to"]] },
      nbSeeders: { selector: "td.coll-2", filters: [["parseInt"]] },
      nbLeechers: { selector: "td.coll-3", filters: [["parseInt"]] },
      // The size cell embeds a completed-count span; take the leading size.
      fileSize: { selector: "td.coll-4", filters: [["regex", "^[\\d.,]+\\s*[KMGT]?i?B"], ["parseSize"]] },
      // "Mar. 3rd '18" — parseDate normalises the ordinal and two-digit year.
      added: { selector: "td.coll-date", filters: [["parseDate"]] }
    },
    magnetFollow: { selector: "a[href^=magnet]", attribute: "href" }
  },
  {
    // A meta-search that scrapes many trackers and — unlike almost every other
    // HTML indexer — ships the magnet, size and full swarm IN the result row,
    // so no per-result detail fetch is needed. Verified server-rendered (2026-08).
    // The domain is mid-move: bitsearch.to 302s to bitsearch.eu, so we point
    // straight at .eu to save the hop (and to keep redirectHijack quiet).
    schemaVersion: 1,
    id: "bitsearch",
    name: "BitSearch",
    siteUrl: "https://bitsearch.eu",
    type: "html",
    search: { url: "https://bitsearch.eu/search?q={q}" },
    // A Tailwind card list: the result cards are the p-6 variant; the page's
    // other cards (the results-count header) are p-4, so .p-6 alone isolates them.
    rows: { selector: "div.shadow-sm.p-6" },
    fields: {
      fileName: { selector: "h3 a" },
      fileUrl: { selector: "a[href^=magnet]", attribute: "href" },
      // The info row (.mb-3) holds category · size · date; size is its 2nd
      // DIRECT child span — the descendant form catches the inner text spans.
      fileSize: { selector: ".mb-3 > span:nth-child(2)", filters: [["regex", "[0-9.,]+\\s*[KMGT]?i?B"], ["parseSize"]] },
      // The info row's 3rd direct child is the date span ("2/22/2024").
      added: { selector: ".mb-3 > span:nth-child(3)", filters: [["parseDate"]] },
      // Swarm counts carry colour classes of their own — the only clean hook.
      nbSeeders: { selector: ".text-green-600 .font-medium", filters: [["parseInt"]] },
      nbLeechers: { selector: ".text-red-600 .font-medium", filters: [["parseInt"]] }
    }
  },
  {
    // A RARBG-lineage clone with the classic `lista2` results table. The magnet
    // lives on the detail page, so this is a magnetFollow def — one extra fetch
    // per result the user actually adds, never during the search. Verified
    // server-rendered (2026-08); may sit behind a Cloudflare challenge on some
    // networks, in which case the summary panel reports it as failed/blocked.
    schemaVersion: 1,
    id: "rargb",
    name: "RARGB",
    siteUrl: "https://rargb.to",
    type: "html",
    search: { url: "https://rargb.to/search/?search={q}" },
    rows: { selector: "tr.lista2" },
    fields: {
      // Match the torrent-detail anchor directly: the row's first cell is a
      // category-image link, so a positional `td a` picks the wrong one.
      fileName: { selector: "a[href^=/torrent/]" },
      descrLink: { selector: "a[href^=/torrent/]", attribute: "href", filters: [["prepend", "https://rargb.to"]] },
      fileSize: { selector: "td:nth-child(5)", filters: [["parseSize"]] },
      // The 4th cell is the upload datetime ("2026-08-08 09:06:09").
      added: { selector: "td:nth-child(4)", filters: [["parseDate"]] },
      // Seeders sit inside a <font> tag; nodeText reads through it.
      nbSeeders: { selector: "td:nth-child(6)", filters: [["parseInt"]] },
      nbLeechers: { selector: "td:nth-child(7)", filters: [["parseInt"]] }
    },
    magnetFollow: { selector: "a[href^=magnet]", attribute: "href" }
  }
];
// TorrentGalaxy (`tgx`) is deliberately absent (qBittorrent dropped it too): a
// def that no longer answers costs every search a timeout.

// --- Validation -----------------------------------------------------------------

// Human-readable problems for a definition — what the settings paste box
// shows, and the tripwire proving every bundled def stays valid.
function validateIndexerDef(def, existingIds) {
  var problems = [];
  var d = def || {};
  var push = function (msg) {
    problems.push(msg);
  };
  if (!/^[a-z0-9][a-z0-9_-]{0,31}$/.test(String(d.id || ""))) push("“id” must be 1–32 chars of a-z, 0-9, - or _");
  else if (existingIds && existingIds[d.id]) push("“id” “" + d.id + "” is already taken");
  if (!String(d.name || "").trim()) push("“name” is required");
  if (!/^https?:\/\//.test(String(d.siteUrl || ""))) push("“siteUrl” must be an http(s) URL");
  var type = String(d.type || "");
  if (type !== "json" && type !== "rss" && type !== "html") push("“type” must be json, rss or html");
  var searchUrl = d.search && d.search.url;
  if (!/^https?:\/\//.test(String(searchUrl || ""))) push("“search.url” must be an http(s) URL");
  else if (String(searchUrl).indexOf("{q}") === -1) push("“search.url” must contain {q}");
  if (type === "html") {
    var rowsSel = d.rows && d.rows.selector;
    if (!rowsSel) push("an html definition needs “rows.selector”");
    else {
      var parsedRows = parseSelector(rowsSel);
      if (parsedRows.error) push("“rows.selector”: " + parsedRows.error);
    }
  } else if (type === "json") {
    if (!d.rows || typeof d.rows.path !== "string") push("a json definition needs “rows.path” (\"\" for the response root)");
  }
  var fields = d.fields || {};
  var allowedFields = { fileName: 1, fileUrl: 1, fileSize: 1, nbFiles: 1, added: 1, nbSeeders: 1, nbLeechers: 1, descrLink: 1 };
  for (var key in fields) {
    if (!Object.prototype.hasOwnProperty.call(fields, key)) continue;
    if (!allowedFields[key]) {
      push("unknown field “" + key + "”");
      continue;
    }
    var spec = fields[key] || {};
    if (key === "fileUrl" && spec.magnet) {
      if (type !== "json") push("“fileUrl.magnet” is only for json definitions");
      if (!spec.magnet.infoHash) push("“fileUrl.magnet” needs “infoHash”");
      var trackers = spec.magnet.trackers || [];
      for (var t = 0; t < trackers.length; t++) {
        if (!/^(udp|https?):\/\//.test(String(trackers[t]))) push("tracker “" + trackers[t] + "” must be udp:// or http(s)://");
      }
    } else {
      var sources = 0;
      if (typeof spec.path === "string") sources++;
      if (spec.tag) sources++;
      if (spec.selector) sources++;
      if (sources !== 1) push("field “" + key + "” needs exactly one source (path / tag / selector)");
      else if (type === "json" && typeof spec.path !== "string") push("field “" + key + "” must use “path” in a json definition");
      else if (type === "rss" && !spec.tag) push("field “" + key + "” must use “tag” in an rss definition");
      else if (type === "html") {
        if (!spec.selector) push("field “" + key + "” must use “selector” in an html definition");
        else {
          var parsedField = parseSelector(spec.selector);
          if (parsedField.error) push("field “" + key + "”: " + parsedField.error);
        }
      }
    }
    var filters = spec.filters || [];
    for (var f = 0; f < filters.length; f++) {
      var fname = filters[f] && filters[f][0];
      if (!KNOWN_FILTERS[fname]) push("field “" + key + "”: unknown filter “" + fname + "”");
      else if (filters[f].length !== KNOWN_FILTERS[fname]) push("field “" + key + "”: filter “" + fname + "” takes " + (KNOWN_FILTERS[fname] - 1) + " argument(s)");
      else if (fname === "regex") {
        try {
          new RegExp(filters[f][1]);
        } catch (e) {
          push("field “" + key + "”: regex “" + filters[f][1] + "” doesn't compile");
        }
      }
    }
  }
  if (!fields.fileName) push("“fields.fileName” is required");
  if (!fields.fileUrl && !d.magnetFollow) push("“fields.fileUrl” is required unless “magnetFollow” is set");
  if (d.magnetFollow) {
    if (type !== "html") push("“magnetFollow” is only for html definitions");
    else if (!d.magnetFollow.selector) push("“magnetFollow” needs a “selector”");
    else {
      var parsedFollow = parseSelector(d.magnetFollow.selector);
      if (parsedFollow.error) push("“magnetFollow.selector”: " + parsedFollow.error);
    }
    if (d.magnetFollow && !fields.descrLink) push("“magnetFollow” needs “fields.descrLink” (the detail page to follow)");
  }
  if (d.limit !== undefined && !(d.limit >= 1 && d.limit <= 100)) push("“limit” must be 1–100");
  if (d.search && d.search.timeoutMs !== undefined && !(d.search.timeoutMs >= 2000 && d.search.timeoutMs <= 20000)) push("“search.timeoutMs” must be 2000–20000");
  if (d.search && d.search.minGapMs !== undefined && !(d.search.minGapMs >= 0 && d.search.minGapMs <= 60000)) push("“search.minGapMs” must be 0–60000");
  return problems;
}

// --- The sweep --------------------------------------------------------------------

// Per-HOST politeness: consecutive hits on one host are spaced by minGap +
// jitter (the google plugin's pattern), while different indexers run in
// parallel — a second same-host hit inside a second is the Cloudflare ban
// signature; hits on different sites are unrelated.
var webHostChains = {};

// The real fetch, injected everywhere else so tests can substitute a stub —
// the sandbox shadows global fetch and no test ever calls activate().
function webFetchFn(url, init) {
  return api.network.fetch(url, init);
}

// In-memory health per def id — { ok, fail, lastError } — for the settings
// note and the debug narration. Session-only, like the google plugin's stats.
var webIndexerStats = {};

function hostOf(url) {
  var m = /^https?:\/\/([^/]+)/i.exec(String(url || ""));
  return m ? m[1].toLowerCase() : "";
}

function throttledWebFetch(url, def, fetchFn, opts) {
  var host = hostOf(url);
  var minGap = (opts && opts.minGapMs !== undefined) ? opts.minGapMs : (def.search && def.search.minGapMs) || WEB_MIN_GAP_MS;
  var chain = webHostChains[host] || { tail: Promise.resolve(), lastAt: 0 };
  webHostChains[host] = chain;
  var run = chain.tail.then(function () {
    var wait = Math.max(0, chain.lastAt + minGap + Math.random() * WEB_GAP_JITTER_MS - Date.now());
    return delay(wait).then(function () {
      chain.lastAt = Date.now();
      return fetchFn(url, {
        method: "GET",
        headers: (def.search && def.search.headers) || undefined,
        timeoutMs: (def.search && def.search.timeoutMs) || WEB_TIMEOUT_MS
      });
    });
  });
  // The chain survives a failed request; the caller still sees the rejection.
  chain.tail = run.then(
    function () {
      return null;
    },
    function () {
      return null;
    }
  );
  // Resolves `{ status, body, url }` rather than the body alone, and a non-2xx
  // error carries `.status` too — the code is the most useful thing an indexer
  // ever tells us (403 is a bot wall, 404 a moved search path, 503 the site
  // being down) and the summary panel reports it per engine. Throwing a bare
  // "HTTP 403" string forced the caller to re-parse its own message. `url` is
  // the final URL after redirects (absent on hosts older than the field) —
  // see redirectHijack for why it matters.
  return run.then(function (resp) {
    var status = Number(resp && resp.status) || 0;
    if (status < 200 || status >= 300) {
      var err = new Error("HTTP " + status);
      err.status = status;
      throw err;
    }
    return resp.text().then(function (body) {
      return { status: status, body: body, url: resp.url };
    });
  });
}

// The host a response REALLY came from, when it isn't the one asked — or null
// when the answer is honest (or the host is too old to say, `resp.url` absent).
//
// This is how national ISP blocking looks from inside a fetch: the request for
// 1337x.to is 302'd to the regulator's notice page (Greece's edppi.gr, and its
// equivalents in the UK, Italy, Portugal…), which answers HTTP 200 with a page
// that naturally contains no torrent rows. Without this check that reads as
// "HTTP 200 · no results" — the stale-selectors diagnosis — sending whoever
// debugs it to exactly the wrong place. `www.` is stripped before comparing so
// a site canonicalising to/from its www form doesn't read as a hijack.
function redirectHijack(requestUrl, finalUrl) {
  var asked = hostOf(requestUrl);
  var got = hostOf(finalUrl);
  if (!asked || !got) return null;
  var strip = function (h) { return h.replace(/^www\./, ""); };
  return strip(asked) === strip(got) ? null : got;
}

function recordWebStat(id, ok, err) {
  var s = webIndexerStats[id] || { ok: 0, fail: 0, lastError: null };
  webIndexerStats[id] = s;
  if (ok) s.ok++;
  else {
    s.fail++;
    s.lastError = err || null;
  }
}

// Search every enabled definition, in parallel across hosts, failures
// isolated: a dead site records a stat and yields ONE notice-shaped row
// (fileSize/seeders/leechers = -1) that the existing search-notice rendering
// prints as "web:x: HTTP 403" — the sweep itself never rejects.
function webSearchAll(defs, query, fetchFn, opts) {
  var list = defs || [];
  var q = String(query == null ? "" : query).trim();
  if (!q || !list.length) return Promise.resolve([]);
  // Optional, so this stays a function of its arguments: the Search tab hands
  // in a recorder for its summary panel, and the headless callers (discovery,
  // the Music Search tab) pass nothing and are unaffected.
  var onStatus = (opts && opts.onStatus) || null;
  var reportStatus = function (id, status) {
    if (onStatus) onStatus("web:" + id, status);
  };
  var jobs = [];
  for (var i = 0; i < list.length; i++) {
    (function (def) {
      var url = buildSearchUrl(def, q);
      dbg("search: [web:" + def.id + "] GET " + url);
      jobs.push(
        throttledWebFetch(url, def, fetchFn, opts)
          .then(function (res) {
            var rows = runDefOnBody(def, res.body);
            reportStatus(def.id, res.status);
            // Zero rows from a host we never asked is a block page wearing a
            // 200, not an empty answer — say so, as a failure. Only when zero:
            // a mirror redirect that still parses fine is results, not a fault.
            var hijack = rows.length ? null : redirectHijack(url, res.url);
            if (hijack) {
              var msg = "redirected to " + hijack + " — the site looks blocked on your network";
              recordWebStat(def.id, false, msg);
              dbg("search: [web:" + def.id + "] " + msg);
              return [
                {
                  fileName: msg,
                  fileSize: -1,
                  nbSeeders: -1,
                  nbLeechers: -1,
                  engineName: "web:" + def.id,
                  siteUrl: def.siteUrl
                }
              ];
            }
            recordWebStat(def.id, true);
            dbg("search: [web:" + def.id + "] HTTP " + res.status + ", " + rows.length + " rows");
            return rows;
          })
          .catch(function (e) {
            recordWebStat(def.id, false, errText(e));
            // 0 for "never got a response at all" — a timeout or a DNS failure,
            // which is a different diagnosis from a site that answered 403.
            reportStatus(def.id, (e && e.status) || 0);
            console.error("rqbit: web indexer " + def.id + " failed:", e);
            dbg("search: [web:" + def.id + "] failed — " + errText(e));
            return [
              {
                fileName: errText(e),
                fileSize: -1,
                nbSeeders: -1,
                nbLeechers: -1,
                engineName: "web:" + def.id,
                siteUrl: def.siteUrl
              }
            ];
          })
      );
    })(list[i]);
  }
  return Promise.all(jobs).then(function (results) {
    var out = [];
    var real = 0;
    for (var r = 0; r < results.length; r++) {
      for (var j = 0; j < results[r].length; j++) {
        var row = results[r][j];
        if (isPluginNotice(row)) {
          out.push(row); // notices exempt from the cap
        } else if (real < WEB_TOTAL_ROW_CAP) {
          out.push(row);
          real++;
        }
      }
    }
    return out;
  });
}

// The definitions currently in force: the bundled ones minus the user's
// disables (Settings → rqbit → Search sites).
function enabledWebDefs() {
  var out = [];
  for (var i = 0; i < WEB_DEFS.length; i++) {
    if (!disabledIndexers[WEB_DEFS[i].id]) out.push(WEB_DEFS[i]);
  }
  return out;
}

function webDefById(id) {
  var all = WEB_DEFS;
  for (var i = 0; i < all.length; i++) {
    if (all[i].id === id) return all[i];
  }
  return null;
}

// Lazy magnet resolution for magnetFollow rows: the list page had no magnet,
// only the detail URL. Fetched at ADD time, once, for the one row the user
// actually wants — an eager per-row fetch would hammer the site 20+ times per
// search for results nobody clicks.
function resolveWebFileUrl(result, fetchFn) {
  if (!result || !result.webFollow) return Promise.resolve(result);
  var def = webDefById(result.webFollow);
  if (!def || !def.magnetFollow) return Promise.resolve(result);
  dbg("add: [web:" + def.id + "] fetching the detail page for its magnet — " + result.fileUrl);
  return throttledWebFetch(result.fileUrl, def, fetchFn).then(function (res) {
    var el = selectFirst(parseMarkup(res.body, true), def.magnetFollow.selector);
    var magnet = el && el.attrs ? el.attrs[String(def.magnetFollow.attribute || "href").toLowerCase()] : null;
    if (!magnet || magnet.indexOf("magnet:") !== 0) {
      throw new Error("No magnet link found on the torrent's page");
    }
    var out = {};
    for (var k in result) {
      if (Object.prototype.hasOwnProperty.call(result, k)) out[k] = result[k];
    }
    out.fileUrl = magnet;
    delete out.webFollow;
    return out;
  });
}

// ---------------------------------------------------------------------------
// Settings persistence
// ---------------------------------------------------------------------------

function loadSettings() {
  return api.storage.get(STORAGE_KEY).then(function (s) {
    s = s || {};
    destCollectionId = s.destCollectionId ? String(s.destCollectionId) : "";
    audioOnly = s.audioOnly !== false;
    disabledIndexers = s.disabledIndexers && typeof s.disabledIndexers === "object" ? s.disabledIndexers : {};
  }).catch(function (e) {
    console.error("rqbit: could not read settings:", e);
  });
}

function saveSettings() {
  var s = { destCollectionId: destCollectionId, audioOnly: audioOnly, disabledIndexers: disabledIndexers };
  return api.storage.set(STORAGE_KEY, s).catch(function (e) {
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

// `displayName` is what the row says before rqbit reports the torrent's real
// name — a search result's title beats a magnet's bare hash.
function startJob(source, displayName) {
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
    displayName: displayName || sourceDisplayName(source),
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
  activeTab = "downloads";
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
// Search — the web indexers, from the view
// ---------------------------------------------------------------------------

// Rows are keyed by their download link — stable across re-sorts, unlike an
// index into the list.
function resultId(r) {
  return String((r && (r.fileUrl || r.descrLink || r.fileName)) || "");
}

function findResult(id) {
  for (var i = 0; i < search.results.length; i++) {
    if (resultId(search.results[i]) === String(id)) return search.results[i];
  }
  return null;
}

// "web:tpb" → "The Pirate Bay".
function indexerName(engineName) {
  var id = String(engineName || "").replace(/^web:/, "");
  var def = webDefById(id);
  return def ? def.name : id;
}

function runSearch(query) {
  var q = String(query || "").trim();
  if (!q) return Promise.resolve();
  activeTab = "search";
  closeBrowse();
  var defs = enabledWebDefs();
  var seq = ++searchSeq;
  if (!defs.length) {
    search = { query: q, running: false, ran: true, results: [], notices: [], allOff: true };
    renderView(true);
    return Promise.resolve();
  }
  search = { query: q, running: true, ran: false, results: [], notices: [], sites: defs.length };
  renderView(true);
  dbg("search: “" + q + "” on " + defs.length + " sites");
  // webSearchAll never rejects — a dead site becomes a notice row — so the
  // catch is only for a bug in our own code.
  return webSearchAll(defs, q, webFetchFn).then(function (rows) {
    if (seq !== searchSeq) return; // a newer search replaced this one
    var results = [];
    var notices = [];
    for (var i = 0; i < rows.length; i++) (isPluginNotice(rows[i]) ? notices : results).push(rows[i]);
    search = { query: q, running: false, ran: true, results: results, notices: notices };
    renderView(true);
  }).catch(function (e) {
    console.error("rqbit: search failed:", e);
    if (seq !== searchSeq) return;
    search = { query: q, running: false, ran: true, results: [], notices: [], error: errText(e) };
    renderView(true);
  });
}

// Pure: the plugin sorts, the host only draws the header arrows. Unknown
// numbers sink to the bottom in either direction.
var RESULT_SORT_KEYS = { size: "fileSize", seeders: "nbSeeders", leechers: "nbLeechers", added: "added" };

function sortResults(rows, by, dir) {
  var out = (rows || []).slice();
  var mult = dir === "asc" ? 1 : -1;
  out.sort(function (a, b) {
    if (by === "source") return mult * indexerName(a.engineName).localeCompare(indexerName(b.engineName));
    var key = RESULT_SORT_KEYS[by] || "nbSeeders";
    var va = swarmCount(a[key]);
    var vb = swarmCount(b[key]);
    if (va === null && vb === null) return 0;
    if (va === null) return 1;
    if (vb === null) return -1;
    return mult * (va - vb);
  });
  return out;
}

var RESULT_COLUMNS = [
  { id: "size", label: "Size", width: 88, align: "right", sortable: true },
  { id: "seeders", label: "Seeders", width: 76, align: "right", sortable: true },
  { id: "leechers", label: "Leechers", width: 82, align: "right", sortable: true },
  { id: "added", label: "Added", width: 104, align: "right", sortable: true },
  { id: "source", label: "Source", width: 120, align: "left", sortable: true }
];

// "" for anything the site didn't report — the host draws one em dash.
function resultRow(r) {
  var size = swarmCount(r.fileSize);
  var seeds = swarmCount(r.nbSeeders);
  var leech = swarmCount(r.nbLeechers);
  return {
    id: resultId(r),
    title: r.fileName || "(untitled)",
    cells: {
      size: size === null ? "" : formatBytes(size),
      seeders: seeds === null ? "" : String(seeds),
      leechers: leech === null ? "" : String(leech),
      added: formatAge(r.added),
      source: indexerName(r.engineName)
    },
    // The NAME opens the torrent's files — a result is a container, and
    // looking inside is free, where Download starts a real transfer.
    action: "rqbit:result-browse"
  };
}

// Download a whole result into the destination collection — the same job a
// pasted magnet starts. A magnet-on-detail-page site is followed first.
function downloadResult(id) {
  var r = findResult(id);
  if (!r) {
    api.ui.showNotification("rqbit: that result is no longer in the list — search again.");
    return Promise.resolve(null);
  }
  var problem = readinessProblem();
  if (problem) {
    api.ui.showNotification("rqbit: " + problem);
    return Promise.resolve(null);
  }
  return resolveWebFileUrl(r, webFetchFn).then(function (res) {
    return startJob(res.fileUrl, r.fileName);
  }).catch(function (e) {
    console.error("rqbit: could not start a search result's download:", e);
    api.ui.showNotification("rqbit: " + errText(e));
    return null;
  });
}

// ---------------------------------------------------------------------------
// Pick tracks — one result's files, each downloadable through the modal
// ---------------------------------------------------------------------------

function browseResult(id) {
  var r = findResult(id);
  if (!r) {
    api.ui.showNotification("rqbit: that result is no longer in the list — search again.");
    return Promise.resolve();
  }
  if (!rqbitDep || !rqbitDep.installed) {
    api.ui.showNotification("rqbit: rqbit is not installed — install it from Settings → Dependencies.");
    return Promise.resolve();
  }
  closeBrowse();
  var state = { resultId: id, title: r.fileName || "", state: "loading", source: null, files: [], error: "", handle: null };
  browse = state;
  renderView(true);
  return resolveWebFileUrl(r, webFetchFn).then(function (res) {
    state.source = res.fileUrl;
    return listTorrentFiles(res.fileUrl, { onStart: function (h) { state.handle = h; } });
  }).then(function (listing) {
    if (browse !== state) return; // closed or replaced meanwhile
    state.handle = null;
    state.state = "ready";
    state.files = listing.files;
    renderView(true);
  }).catch(function (e) {
    if (browse !== state) return; // closing it cancelled the listing — not an error
    console.error("rqbit: could not list the torrent's files:", e);
    state.handle = null;
    state.state = "error";
    state.error = errText(e);
    renderView(true);
  });
}

function closeBrowse() {
  if (!browse) return;
  var h = browse.handle;
  browse = null;
  if (h) {
    h.cancel().catch(function (e) {
      console.error("rqbit: could not stop a file listing:", e);
    });
  }
}

// The modal's track for one file. Its names are a guess from the file and
// release names; the file's own tags replace them once it has downloaded.
function fileTrack(file, releaseName, source) {
  var ft = parseFileTrack(file.name);
  var rel = parseReleaseName(releaseName);
  return {
    title: ft.title,
    artist_name: ft.artist || rel.artist,
    album_title: rel.album,
    uri: fileUri(source, file.name)
  };
}

// Hand tracks to the host download modal: one track opens the single-track
// flow (destination, quality, then the resolve with live progress and a
// Cancel that kills rqbit), several open the multi-track one.
function openDownloadModal(tracks) {
  if (!api.ui || typeof api.ui.requestAction !== "function") {
    api.ui.showNotification("rqbit: this version of Viboplr can't open the download window — update the app.");
    return;
  }
  api.ui.requestAction("download-tracks", { providerId: PROVIDER_ID, providerName: PROVIDER_NAME, tracks: tracks });
}

function downloadBrowsedFiles(ids) {
  if (!browse || browse.state !== "ready") return;
  var tracks = [];
  for (var i = 0; i < ids.length; i++) {
    var f = browse.files[Number(ids[i])];
    if (f && isAudioFile(f.name)) tracks.push(fileTrack(f, browse.title, browse.source));
  }
  if (!tracks.length) {
    api.ui.showNotification("rqbit: pick at least one audio file.");
    return;
  }
  openDownloadModal(tracks);
}

// ---------------------------------------------------------------------------
// Download provider — a file out of a torrent, for the host's download modal
// ---------------------------------------------------------------------------
//
// The modal's resolve IS the download here (the yt-dlp shape): rqbit fetches
// just the one file into a temp folder in plugin storage and the resolve
// answers with its file:// path, which the modal then copies to the
// destination the user chose. Progress goes through api.downloads.
// reportProgress; the modal's Cancel kills rqbit through the host's resolve
// scope and the exec rejects with "Cancelled", which is rethrown verbatim so
// the host stays quiet about a cancel it asked for.

var QUALITIES = [
  { value: "any", label: "Best available", description: "Whatever release has the track and the healthiest swarm." },
  { value: "flac", label: "Prefer lossless (FLAC)", description: "Ranks FLAC / lossless releases first when searching for a track. A file you picked yourself downloads as it is." },
  { value: "mp3", label: "Prefer MP3 320", description: "Ranks 320 kbps / V0 releases first when searching for a track. A file you picked yourself downloads as it is." }
];

function isCancel(e) {
  return errText(e).trim() === "Cancelled";
}

// Progress for the resolve the host is awaiting. Decoration, never the
// resolve itself: a throw here must not kill a working download.
function report(progress) {
  if (!api || !api.downloads || typeof api.downloads.reportProgress !== "function") return;
  try {
    api.downloads.reportProgress(progress);
  } catch (e) {
    console.error("rqbit: progress report failed:", e);
  }
}

function progressDetail(p) {
  var parts = [];
  if (p.totalBytes) parts.push(formatBytes(p.doneBytes) + " / " + formatBytes(p.totalBytes));
  if (p.downMiBps) parts.push("↓ " + p.downMiBps.toFixed(2) + " MiB/s");
  parts.push(p.peersLive + " peer" + (p.peersLive === 1 ? "" : "s"));
  return parts.join(" · ");
}

function ensureRqbit() {
  if (!api.storage.files) return Promise.reject(new Error("This version of Viboplr can't hold rqbit's downloads — update the app"));
  if (rqbitDep && rqbitDep.installed) return Promise.resolve();
  // Installed since activation? Ask again before refusing.
  return loadDependency().then(function (d) {
    if (!d || !d.installed) throw new Error("rqbit is not installed — install it from Settings → Dependencies");
  });
}

// One `rqbit download -l`: the torrent's file list, then exit. A magnet
// nobody seeds lists nothing, forever, so this gives up after LIST_TIMEOUT_MS
// — stopping rqbit through the exec handle, and rejecting even on a host too
// old to hand one out. A host cancel (the modal's Cancel) rejects with
// "Cancelled" verbatim.
function listTorrentFiles(source, opts) {
  opts = opts || {};
  var timeoutMs = opts.timeoutMs || LIST_TIMEOUT_MS;
  var handle = null;
  var name = null;
  return new Promise(function (resolve, reject) {
    var settled = false;
    var timer = setTimeout(function () {
      if (settled) return;
      settled = true;
      if (handle) handle.cancel().catch(function (e) { console.error("rqbit: could not stop a listing:", e); });
      reject(new Error("No peer sent this torrent's file list within " + Math.round(timeoutMs / 1000) + "s — it may be dead"));
    }, timeoutMs);
    api.system.exec(DEP_NAME, buildListArgs(source), {
      cwd: null,
      onOutput: function (line) {
        var n = parseTorrentName(line);
        if (n) name = n;
      },
      onStart: function (h) {
        handle = h;
        if (opts.onStart) opts.onStart(h);
      }
    }).then(function (res) {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      var files = parseListOutput(res.stdout);
      if (!files.length) {
        var reason = parseErrorMessage(res.stdout);
        reject(new Error(reason ? humanizeError(reason) : "rqbit listed no files for this torrent"));
        return;
      }
      resolve({ files: files, name: name });
    }, function (e) {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(e);
    });
  });
}

// --- Temp folders ----------------------------------------------------------

// getPath answers null for a folder that doesn't exist yet; writing a marker
// file creates it (and its parents).
function ensureTmpDir(name) {
  var path = [TMP_DIR, name];
  return api.storage.files.getPath(path).then(function (p) {
    if (p) return p;
    return api.storage.files.writeText(path.concat([".keep"]), "").then(function () {
      return api.storage.files.getPath(path);
    });
  });
}

function removeTmp(name) {
  return api.storage.files.remove([TMP_DIR, name]).catch(function (e) {
    console.error("rqbit: could not remove a temporary download folder:", e);
  });
}

// Remove every temp folder that is neither downloading nor one the modal may
// still be copying from. Each torrent leaves more than the one file behind —
// rqbit creates the unselected files too — so nothing here is worth keeping.
function sweepTmp() {
  return api.storage.files.list([TMP_DIR]).then(function (entries) {
    var chain = Promise.resolve();
    (entries || []).forEach(function (en) {
      if (tmpInFlight[en.name] || tmpDelivered.indexOf(en.name) !== -1) return;
      chain = chain.then(function () { return removeTmp(en.name); });
    });
    return chain;
  }, function () {
    // No temp folder yet — nothing to sweep.
    return null;
  });
}

function markDelivered(name) {
  tmpDelivered.push(name);
  while (tmpDelivered.length > TMP_KEEP_DELIVERED) tmpDelivered.shift();
}

// Where rqbit put the file. Walked rather than predicted: the layout under
// the output folder depends on whether the torrent is single- or multi-file.
// Two discs can both hold "01 - Intro.flac", so the copy whose path ends
// with the torrent's own path for it wins.
function locateDownloaded(dirName, outDir, relPath) {
  var want = String(relPath).replace(/\\/g, "/").split("/").filter(function (s) { return !!s; });
  var base = want[want.length - 1];
  var found = [];
  var walk = function (segs, depth) {
    return api.storage.files.list([TMP_DIR, dirName].concat(segs)).then(function (entries) {
      var chain = Promise.resolve();
      (entries || []).forEach(function (en) {
        if (en.isDir) {
          if (depth < 8) chain = chain.then(function () { return walk(segs.concat([en.name]), depth + 1); });
        } else if (en.name === base) {
          found.push(segs.concat([en.name]));
        }
      });
      return chain;
    });
  };
  return walk([], 0).then(function () {
    if (!found.length) throw new Error("rqbit finished, but “" + base + "” isn't in its download folder");
    var best = found[0];
    for (var i = 0; i < found.length; i++) {
      var tail = found[i].slice(-want.length).join("/");
      if (tail === want.join("/")) best = found[i];
    }
    var sep = outDir.indexOf("/") === -1 && outDir.indexOf("\\") !== -1 ? "\\" : "/";
    return outDir.replace(/[\\/]+$/, "") + sep + best.join(sep);
  });
}

// --- The download ----------------------------------------------------------

// Run rqbit for exactly one file. Two stops of our own on top of the host's
// Cancel: no torrent after FETCH_META_TIMEOUT_MS (a dead magnet hangs rqbit
// silently) and no new bytes for FETCH_STALL_MS. Percent maps into [lo, hi]
// so a hunt's search stages keep the bar monotonic.
function runFetch(source, base, outDir, lo, hi) {
  var handle = null;
  var stopReason = null;
  var added = false;
  var lastBytes = -1;
  var lastGrowth = Date.now();
  var stop = function (reason) {
    if (stopReason) return;
    stopReason = reason;
    dbg("fetch: stopping “" + base + "” — " + reason);
    if (handle) handle.cancel().catch(function (e) { console.error("rqbit: could not stop a download:", e); });
  };
  var metaTimer = setTimeout(function () {
    if (!added) stop("No peers found for this torrent after " + Math.round(FETCH_META_TIMEOUT_MS / 1000) + "s");
  }, FETCH_META_TIMEOUT_MS);
  var stallTimer = setInterval(function () {
    if (added && Date.now() - lastGrowth > FETCH_STALL_MS) stop("The download stalled — no data for " + Math.round(FETCH_STALL_MS / 60000) + " minutes");
  }, 15000);
  var cleanup = function () {
    clearTimeout(metaTimer);
    clearInterval(stallTimer);
  };
  report({ label: "Finding peers…", detail: base });
  var args = buildDownloadArgs({ source: source, outDir: outDir, filenameRe: exactNameRe(base) });
  return api.system.exec(DEP_NAME, args, {
    cwd: null,
    onStart: function (h) { handle = h; },
    onOutput: function (line) {
      if (parseTorrentName(line)) {
        added = true;
        lastGrowth = Date.now();
        return;
      }
      var p = parseProgressLine(line);
      if (!p) return;
      added = true;
      if ((p.doneBytes || 0) > lastBytes) {
        lastBytes = p.doneBytes || 0;
        lastGrowth = Date.now();
      }
      report({ percent: lo + ((hi - lo) * p.percent) / 100, label: "Downloading “" + base + "”", detail: progressDetail(p), etaSecs: p.etaSecs });
    }
  }).then(function (res) {
    cleanup();
    var outcome = classifyOutcome(res.exitCode, res.stdout);
    if (outcome.ok) return;
    if (stopReason) throw new Error(stopReason);
    if (outcome.cancelled) throw new Error("Cancelled");
    if (/none of the filenames match/i.test(parseErrorMessage(res.stdout))) throw new Error("The torrent has no file named “" + base + "”");
    throw new Error(outcome.message);
  }, function (e) {
    cleanup();
    if (stopReason) throw new Error(stopReason);
    throw e;
  });
}

function readTags(path) {
  if (!api.system || typeof api.system.readAudioTags !== "function") return Promise.resolve(null);
  return api.system.readAudioTags([path]).then(function (list) {
    return (list && list[0]) || null;
  }).catch(function (e) {
    console.error("rqbit: could not read the downloaded file's tags:", e);
    return null;
  });
}

// Pure: the modal copies a file:// answer with the host's download_file, which
// percent-DECODES everything after "file://" and otherwise takes the path raw.
// So "%" is the one character to escape — "100% Pure.flac" would otherwise
// decode into a different (or invalid) name.
function fileUrlFor(absPath) {
  return "file://" + String(absPath).replace(/%/g, "%25");
}

// Pure: the resolve's metadata. `primary` wins field by field, `tags` fill
// the gaps — a hunt keeps the user's own names for the track, a picked file
// trusts its tags (and passes no primary).
function mergeMetadata(primary, tags) {
  var p = primary || {};
  var t = tags || {};
  var out = {
    title: p.title || t.title || null,
    artist: p.artist || t.artist || null,
    album: p.album || t.album || null,
    trackNumber: t.track_number != null ? t.track_number : null,
    year: t.year != null ? t.year : null,
    genre: t.genre || null
  };
  return out;
}

// Fetch one file out of a torrent into its own temp folder and answer the
// resolve with it. `ctx.band` maps rqbit's percent; `ctx.primary` is
// metadata that beats the file's tags.
function fetchTorrentFile(source, relPath, ctx) {
  ctx = ctx || {};
  var band = ctx.band || [0, 100];
  var base = baseName(relPath);
  var dirName = "job-" + Date.now().toString(36) + "-" + (++tmpSeq);
  tmpInFlight[dirName] = true;
  dbg("fetch: “" + relPath + "” from " + sourceDisplayName(source));
  return sweepTmp().then(function () {
    return ensureTmpDir(dirName);
  }).then(function (outDir) {
    if (!outDir) throw new Error("Could not create a temporary folder for the download");
    return runFetch(source, base, outDir, band[0], band[1]).then(function () {
      return locateDownloaded(dirName, outDir, relPath);
    });
  }).then(function (absPath) {
    delete tmpInFlight[dirName];
    markDelivered(dirName);
    report({ percent: 100, label: "Downloaded", detail: base });
    return readTags(absPath).then(function (tags) {
      return { url: fileUrlFor(absPath), headers: null, ext: extOf(base), metadata: mergeMetadata(ctx.primary, tags) };
    });
  }, function (e) {
    delete tmpInFlight[dirName];
    return removeTmp(dirName).then(function () { throw e; });
  });
}

// --- The hunt: find a torrent that has the track, then fetch just that file --

function huntTrack(want, format) {
  var queries = discoveryQueries(want);
  if (!queries.length) return Promise.resolve(null);
  var defs = enabledWebDefs();
  if (!defs.length) return Promise.reject(new Error("Every torrent search site is turned off — turn some on in Settings → rqbit"));
  var ctx = { title: want.title, artist: want.artist, album: want.album, format: format };
  var what = (want.artist ? want.artist + " — " : "") + want.title;
  dbg("hunt: “" + what + "”" + (format ? " (" + format + ")" : ""));

  var trySearch = function (idx) {
    if (idx >= queries.length) return Promise.resolve([]);
    report({ percent: 2 + 3 * idx, label: "Searching torrent sites", detail: "“" + queries[idx] + "”" });
    return webSearchAll(defs, queries[idx], webFetchFn).then(function (rows) {
      var ranked = rankCandidates(rows, ctx);
      dbg("hunt: “" + queries[idx] + "” → " + rows.length + " rows, " + ranked.length + " worth checking");
      return ranked.length ? ranked : trySearch(idx + 1);
    });
  };

  var lastError = null;
  var examine = function (candidates, i) {
    if (i >= candidates.length) {
      var why = lastError ? " (last problem: " + errText(lastError) + ")" : "";
      return Promise.reject(new Error("Checked " + candidates.length + " torrent" + (candidates.length === 1 ? "" : "s") + " — none had “" + want.title + "”" + why));
    }
    var r = candidates[i];
    var source = null;
    report({ percent: 10 + i * 8, label: "Checking torrent " + (i + 1) + " of " + candidates.length, detail: r.fileName });
    dbg("hunt: checking “" + r.fileName + "”");
    var next = function (e) {
      if (isCancel(e)) throw e;
      if (e) {
        lastError = e;
        dbg("hunt:   " + errText(e) + " — next");
      }
      return examine(candidates, i + 1);
    };
    return resolveWebFileUrl(r, webFetchFn).then(function (res) {
      source = res.fileUrl;
      return listTorrentFiles(source);
    }).then(function (listing) {
      var file = pickFileForTrack(listing.files, listing.name || r.fileName, want);
      if (!file) {
        dbg("hunt:   " + listing.files.length + " files, none is the track — next");
        return examine(candidates, i + 1);
      }
      dbg("hunt:   picked “" + file.name + "”");
      return fetchTorrentFile(source, file.name, {
        band: [35, 100],
        primary: { title: want.title, artist: want.artist, album: want.album }
      }).catch(next);
    }, next);
  };

  return trySearch(0).then(function (candidates) {
    if (!candidates.length) throw new Error("No torrent for “" + what + "” turned up on the search sites");
    return examine(candidates, 0);
  });
}

// --- Registration ------------------------------------------------------------

function resolveDownloadByUri(uri, format) {
  var ref = parseRqbitUri(uri);
  if (!ref) return Promise.resolve(null);
  return ensureRqbit().then(function () {
    // A picked file is fetched as it is, whatever `format` asks for.
    if (ref.kind === "file") return fetchTorrentFile(ref.source, ref.path, {});
    return huntTrack(ref.want, format);
  });
}

function resolveDownloadByMetadata(title, artistName, albumName, durationSecs, format) {
  var want = {
    title: String(title || "").trim(),
    artist: String(artistName || "").trim(),
    album: String(albumName || "").trim(),
    durationSecs: numOr(durationSecs, 0)
  };
  if (!want.title) return Promise.resolve(null);
  return ensureRqbit().then(function () {
    return huntTrack(want, format);
  });
}

// The "rqbit (download only)" entry in Settings → Providers. It never plays
// anything — fetching a torrent can't fit a 60s stream resolve — and answers
// every play with an instant decline. It exists because the host picks the
// downloader for a track with no source (a detail page's "Not in library"
// row, an unresolved queue entry) as the first stream resolver in the user's
// order whose plugin also provides downloads; placing this entry is how the
// user chooses rqbit for those.
function declineStream() {
  return Promise.resolve(null);
}

function registerProviders() {
  if (api.downloads) {
    if (typeof api.downloads.onResolveByUri === "function") api.downloads.onResolveByUri(PROVIDER_ID, resolveDownloadByUri);
    if (typeof api.downloads.onResolveByMetadata === "function") api.downloads.onResolveByMetadata(PROVIDER_ID, resolveDownloadByMetadata);
    if (typeof api.downloads.onGetQualities === "function") api.downloads.onGetQualities(PROVIDER_ID, function () { return QUALITIES; });
  }
  if (api.playback && typeof api.playback.onStreamResolve === "function") {
    api.playback.onStreamResolve(RESOLVER_ID, declineStream);
  }
}

// ---------------------------------------------------------------------------
// Context menu
// ---------------------------------------------------------------------------

function registerContextMenu() {
  if (!api.contextMenu || typeof api.contextMenu.onAction !== "function") return;
  // Open the view FIRST so the user lands on the running search, not on a
  // page that changes under them when it finishes.
  api.contextMenu.onAction("rqbit-find-torrents", function (target) {
    var q = searchQueryForTarget(target);
    if (!q) {
      api.ui.showNotification("rqbit: nothing to search for on that item.");
      return;
    }
    if (typeof api.ui.navigateToView === "function") api.ui.navigateToView(VIEW_ID);
    return runSearch(q);
  });
  // The hunt runs inside the download modal (see findUri), so the user picks
  // the destination first and then watches it — nothing starts from the click.
  api.contextMenu.onAction("rqbit-download", function (target) {
    var t = target || {};
    var title = String(t.title || "").trim();
    if (!title) {
      api.ui.showNotification("rqbit: that item has no title to search for.");
      return;
    }
    var want = { title: title, artist: String(t.artistName || "").trim(), album: String(t.albumTitle || "").trim() };
    openDownloadModal([{ title: want.title, artist_name: want.artist || null, album_title: want.album || null, uri: findUri(want) }]);
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

function browseNodes() {
  var b = browse;
  var children = [
    {
      type: "toolbar",
      buttons: [
        { label: "← Results", action: "rqbit:browse-close", variant: "secondary" },
        { label: "Download whole torrent", action: "rqbit:result-download", data: { itemId: b.resultId }, variant: "secondary" }
      ]
    },
    { type: "text", content: b.title, className: "title" }
  ];
  if (b.state === "loading") {
    children.push({ type: "loading", message: "Asking peers for the file list — up to " + Math.round(LIST_TIMEOUT_MS / 1000) + "s" });
    return children;
  }
  if (b.state === "error") {
    children.push({ type: "text", className: "ds-banner ds-banner--warning", content: b.error });
    return children;
  }
  var items = [];
  var audioIds = [];
  for (var i = 0; i < b.files.length; i++) {
    var f = b.files[i];
    var audio = isAudioFile(f.name);
    var folder = String(f.name).replace(/\\/g, "/");
    var slash = folder.lastIndexOf("/");
    if (audio) audioIds.push(String(i));
    items.push({
      id: String(i),
      title: baseName(f.name),
      subtitle: slash > 0 ? folder.slice(0, slash) : undefined,
      cells: { size: f.sizeBytes == null ? "" : formatBytes(f.sizeBytes) },
      actions: audio ? ["rqbit:file-download"] : [],
      action: audio ? "rqbit:file-download" : undefined
    });
  }
  children.push({
    type: "text",
    className: "muted",
    content: "Download… fetches only the files you pick and lets you choose where they go. Download whole torrent puts everything in your destination collection."
  });
  children.push({
    type: "track-row-list",
    selectable: true,
    // Files, not tracks: Play / Enqueue would offer what can't happen yet.
    contextMenu: false,
    // Names here are guesses about things the user may not have — never fetch
    // a cover for each.
    artwork: "cached",
    showHeader: true,
    columns: [{ id: "size", label: "Size", width: 88, align: "right" }],
    selectionPresets: [{ id: "audio", label: "Audio", ids: audioIds }],
    items: items,
    actions: [{ id: "rqbit:file-download", label: "Download…", icon: "⬇" }]
  });
  return children;
}

function searchNodes() {
  if (browse) return browseNodes();
  var children = [];
  if (search.running) {
    children.push({ type: "loading", message: "Searching " + search.sites + " site" + (search.sites === 1 ? "" : "s") + " for “" + search.query + "”…" });
    return children;
  }
  if (!search.ran) {
    children.push({
      type: "text",
      className: "muted",
      content: "Search torrent sites for an artist or album, or paste a magnet link to download it straight away. Open a result to pick single tracks; Download takes the whole torrent."
    });
    return children;
  }
  if (search.allOff) {
    children.push({ type: "text", className: "ds-banner ds-banner--warning", content: "Every search site is turned off — turn some on in Settings → rqbit." });
    return children;
  }
  if (search.error) {
    children.push({ type: "text", className: "error", content: "Search failed — " + search.error });
  }
  if (search.results.length) {
    var rows = sortResults(search.results, sortBy, sortDir);
    var items = [];
    for (var i = 0; i < rows.length; i++) items.push(resultRow(rows[i]));
    children.push({
      type: "track-row-list",
      selectable: true,
      selectionMode: "single",
      contextMenu: false,
      artwork: "cached",
      showHeader: true,
      columns: RESULT_COLUMNS,
      sortBy: sortBy,
      sortDir: sortDir,
      sortAction: "rqbit:result-sort",
      openOnClick: "title",
      items: items,
      actions: [
        { id: "rqbit:result-download", label: "Download", icon: "⬇" },
        { id: "rqbit:result-browse", label: "Pick tracks…", icon: "📂" }
      ]
    });
  } else if (!search.error) {
    children.push({ type: "text", className: "muted", content: "Nothing found for “" + search.query + "”." });
  }
  for (var n = 0; n < search.notices.length; n++) {
    var nt = search.notices[n];
    children.push({ type: "text", className: "muted", content: indexerName(nt.engineName) + ": " + nt.fileName });
  }
  return children;
}

function downloadNodes() {
  var children = [];
  var col = collectionById(destCollectionId);
  if (!col || !col.path) {
    children.push({ type: "text", className: "ds-banner ds-banner--warning", content: "Choose the collection downloads should land in (Settings → rqbit)." });
  }
  if (!jobs.length) {
    children.push({ type: "text", className: "muted", content: "Each download runs as its own rqbit process and stops when it finishes. Files land in the collection chosen in Settings → rqbit and are scanned into your library automatically." });
  }
  for (var i = 0; i < jobs.length; i++) children.push(jobNodes(jobs[i]));
  return children;
}

function viewTree() {
  var children = [];
  if (!rqbitDep || !rqbitDep.installed) {
    children.push({ type: "text", className: "ds-banner ds-banner--warning", content: "rqbit is not installed — install it from Settings → Dependencies." });
  }
  children.push({
    type: "search-input",
    placeholder: "Search torrents, or paste a magnet link",
    buttonLabel: "Go",
    pasteButton: true,
    action: "rqbit:add",
    stateKey: "add"
  });
  // How many are RUNNING is the view header's job (viewHeaderFor); the tab
  // counts rows, like every other tab count.
  children.push({
    type: "tabs",
    activeTab: activeTab,
    action: "rqbit:tab",
    tabs: [
      { id: "search", label: "Search", count: search.results.length || undefined },
      { id: "downloads", label: "Downloads", count: jobs.length || undefined }
    ]
  });
  children = children.concat(activeTab === "downloads" ? downloadNodes() : searchNodes());
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
  api.ui.setViewData(VIEW_ID, viewTree(), { scrollKey: activeTab === "search" && browse ? "files" : activeTab });
  pushViewHeader();
}

// Sends the header only when it changed: progress re-renders the view about
// twice a second, and each setViewHeader re-renders the host.
function pushViewHeader() {
  if (!api || !api.ui || typeof api.ui.setViewHeader !== "function") return; // host < 1.0.77
  var canOpen = !!(api.system && typeof api.system.openPath === "function");
  var header = viewHeaderFor(rqbitDep, collectionById(destCollectionId), jobs, canOpen);
  var key = JSON.stringify(header);
  if (key === lastViewHeader) return;
  lastViewHeader = key;
  api.ui.setViewHeader(VIEW_ID, header);
}

function openDestination() {
  var col = collectionById(destCollectionId);
  if (!col || !col.path || !api.system || typeof api.system.openPath !== "function") return;
  api.system.openPath(col.path).catch(function (e) {
    console.error("rqbit: could not open folder:", e);
    api.ui.showNotification("rqbit: could not open " + col.path);
  });
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

function indexerRows() {
  var rows = [];
  for (var i = 0; i < WEB_DEFS.length; i++) {
    var def = WEB_DEFS[i];
    var stat = webIndexerStats[def.id];
    var note = def.siteUrl.replace(/^https?:\/\//, "");
    if (stat && stat.fail && !stat.ok) note += " · failing this session" + (stat.lastError ? " (" + stat.lastError + ")" : "");
    rows.push({
      type: "settings-row",
      label: def.name,
      description: note,
      control: { type: "toggle", label: "", action: "rqbit:indexer:" + def.id, checked: !disabledIndexers[def.id] }
    });
  }
  return rows;
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
            description: "Whole-torrent downloads go into their own folder inside this collection, which is rescanned when they finish. Tracks downloaded through the download window go wherever you choose there.",
            control: { type: "select", action: "rqbit:set-dest", value: destCollectionId, options: destinationOptions() }
          },
          {
            type: "settings-row",
            label: "Audio files only",
            description: "Skip everything in a whole-torrent download that isn't music (cover scans, .nfo, sample videos). Off downloads the whole torrent.",
            control: { type: "toggle", label: "", action: "rqbit:set-audio-only", checked: !!audioOnly }
          }
        ]
      },
      {
        type: "section",
        title: "Search sites",
        children: [
          { type: "text", className: "muted", content: "The torrent sites Search and the download window look in. A site that is blocked on your network only slows every search down — turn it off." }
        ].concat(indexerRows())
      },
      {
        type: "section",
        title: "How it works",
        children: [
          { type: "text", className: "muted", content: "Every download is a separate rqbit process that exits when it completes. Nothing runs in the background between downloads and nothing is seeded afterwards — if you need to keep seeding (private trackers), use the qBittorrent plugin instead." },
          { type: "text", className: "muted", content: "To make rqbit the downloader for tracks that have no source yet (a detail page's \"Not in library\" rows), move \"rqbit (download only)\" up in Settings → Providers. It never plays anything." }
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

// A track-row-list action names its rows as `selectedIds` (toolbar, multi)
// or `itemId` (a row's own button / double-click).
function rowIds(data) {
  var out = [];
  var ids = data && data.selectedIds;
  if (ids && ids.length) {
    for (var i = 0; i < ids.length; i++) {
      if (ids[i] != null && ids[i] !== "") out.push(String(ids[i]));
    }
  }
  if (!out.length && data && data.itemId != null && data.itemId !== "") out.push(String(data.itemId));
  return out;
}

function registerActions() {
  // One box for both: a magnet / .torrent URL downloads, anything else searches.
  api.ui.onAction("rqbit:add", function (payload) {
    var q = String((payload && (payload.query != null ? payload.query : payload.value)) || "").trim();
    if (!q) return;
    return isTorrentSource(q) ? startJob(q) : runSearch(q);
  });
  api.ui.onAction("rqbit:tab", function (payload) {
    var id = (payload && (payload.tabId || payload.id)) || activeTab;
    if (id === "search" || id === "downloads") activeTab = id;
    renderView(true);
  });
  api.ui.onAction("rqbit:result-sort", function (payload) {
    var col = String((payload && payload.column) || "");
    if (col !== "source" && !RESULT_SORT_KEYS[col]) return;
    if (col === sortBy) sortDir = sortDir === "desc" ? "asc" : "desc";
    else {
      sortBy = col;
      sortDir = col === "source" ? "asc" : "desc";
    }
    renderView(true);
  });
  api.ui.onAction("rqbit:result-download", function (payload) {
    var ids = rowIds(payload);
    if (!ids.length) return;
    return downloadResult(ids[0]);
  });
  api.ui.onAction("rqbit:result-browse", function (payload) {
    var ids = rowIds(payload);
    if (!ids.length) return;
    return browseResult(ids[0]);
  });
  api.ui.onAction("rqbit:browse-close", function () {
    closeBrowse();
    renderView(true);
  });
  api.ui.onAction("rqbit:file-download", function (payload) { downloadBrowsedFiles(rowIds(payload)); });
  api.ui.onAction("rqbit:dismiss", function (payload) { dismissJob(payload && payload.id); });
  api.ui.onAction("rqbit:cancel", function (payload) { return cancelJob(payload && payload.id); });
  api.ui.onAction("rqbit:open", function (payload) { openJobFolder(payload && payload.id); });
  api.ui.onAction("rqbit:open-dest", function () { openDestination(); });
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
  WEB_DEFS.forEach(function (def) {
    api.ui.onAction("rqbit:indexer:" + def.id, function (payload) {
      var on = !!(payload && (payload.checked != null ? payload.checked : payload.value));
      if (on) delete disabledIndexers[def.id];
      else disabledIndexers[def.id] = true;
      return saveSettings().then(function () { renderSettings(); });
    });
  });
  // The view's first search-input is filled by the host from Cmd+K, which
  // fires rqbit:add; this covers a host that routes the query here instead.
  api.ui.onAction("host:search", function (payload) {
    var q = String((payload && payload.query) || "").trim();
    if (!q) return;
    return isTorrentSource(q) ? startJob(q) : runSearch(q);
  });
}

async function activate(hostApi) {
  api = hostApi;
  registerActions();
  registerProviders();
  registerContextMenu();
  await Promise.all([loadSettings(), loadDependency(), loadCollections()]);
  // Nothing is in flight at activation, so every temp folder is a leftover.
  if (api.storage.files) {
    api.storage.files.remove([TMP_DIR]).catch(function (e) {
      console.error("rqbit: could not clear old temporary downloads:", e);
    });
  }
  renderSettings();
  renderView(true);
}

function deactivate() {
  if (renderTimer) { clearTimeout(renderTimer); renderTimer = null; }
  closeBrowse();
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
  searchSeq++; // a search finishing after this must not render
  lastViewHeader = null; // the host drops runtime header state on deactivate
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
  _viewHeaderFor: viewHeaderFor,
  _AUDIO_FILE_RE: AUDIO_FILE_RE,
  _RQBIT_GLOBAL_ARGS: RQBIT_GLOBAL_ARGS,
  _STUCK_AFTER_MS: STUCK_AFTER_MS,
  // Web indexers (ported; the fixture tests pin them).
  _parseHtml: function (text) { return parseMarkup(text, true); },
  _parseXml: function (text) { return parseMarkup(text, false); },
  _nodeText: nodeText,
  _decodeEntities: decodeEntities,
  _parseSelector: parseSelector,
  _selectAll: selectAll,
  _childByTag: childByTag,
  _parseHumanSize: parseHumanSize,
  _applyFilters: applyFilters,
  _jsonPath: jsonPath,
  _buildSearchUrl: buildSearchUrl,
  _buildMagnet: buildMagnet,
  _runDefOnBody: runDefOnBody,
  _validateIndexerDef: validateIndexerDef,
  _redirectHijack: redirectHijack,
  _webSearchAll: webSearchAll,
  _resolveWebFileUrl: resolveWebFileUrl,
  _WEB_DEFS: WEB_DEFS,
  // Matching, hunting, URIs.
  _normalizeForMatch: normalizeForMatch,
  _titleMatchScore: titleMatchScore,
  _pickFileForTrack: pickFileForTrack,
  _parseFileTrack: parseFileTrack,
  _parseReleaseName: parseReleaseName,
  _discoveryQueries: discoveryQueries,
  _rankCandidates: rankCandidates,
  _searchQueryForTarget: searchQueryForTarget,
  _fileUri: fileUri,
  _findUri: findUri,
  _parseRqbitUri: parseRqbitUri,
  _exactNameRe: exactNameRe,
  _sortResults: sortResults,
  _mergeMetadata: mergeMetadata,
  _fileUrlFor: fileUrlFor,
  _isPluginNotice: isPluginNotice
};
