// Bili Ripper for Surge.
// Moves Bilibili media requests onto chosen upos nodes and, in fanout mode, downloads one
// Range from several nodes at once. Node lists and relay detection follow
// Bilibili-thread-ripper (MIT, MrTangLuyao).
//
// One file serves two hooks: http-request (swap / fanout) and http-response (node health).

const STATE_KEY = "bili-ripper.state";
// A node that refused twice in a row is left alone for a while; one that merely gave no
// reply is tried again much sooner, since that is usually a passing connection problem.
// Each ban in a row lasts twice as long as the one before, up to BAN_MAX_MS, so a node that
// is down for good stops being tried every minute; any success resets the run.
const BAN_MS = 5 * 60 * 1000;
const BLIP_BAN_MS = 60 * 1000;
const BAN_MAX_MS = 30 * 60 * 1000;
// A file refused by two nodes stays on its original host for this long: some files are only
// served by the host Bilibili named. The record lives in state.refused, keyed by the file's
// directory, which holds every stream of one video.
const HOSTILE_MS = 10 * 60 * 1000;
const MAX_REFUSED = 32;
// Bilibili refuses every node for about a minute after a burst from one address. Two videos
// refused within this window mean the address is throttled: fanout pauses, twice as long
// each time it happens again, up to this many doublings.
const COOLDOWN_MS = 2 * 60 * 1000;
const COOLDOWN_MAX_DOUBLINGS = 2;
// A measured speed older than this still ranks the node, but it is measured again: one such
// node per Range, one chunk at a time, so a slow one costs a hedged chunk, not the whole Range.
const SPEED_TTL_MS = 60 * 60 * 1000;
// A swapped request that got no response within this window is counted against its node.
const STALE_ASSIGN_MS = 30 * 1000;
// A node may send the headers of a good reply and then no body; the player gives up and asks
// for the same Range again. So a good status only counts once this window has passed without
// the same Range being asked for again; a repeat inside it is counted against the node.
const RETRY_WINDOW_MS = 10 * 1000;
const MAX_ASSIGNS = 64;
const MAX_ATTEMPTS = 3;
const CHUNK_TIMEOUT_S = 15;
// A chunk still running this many times longer than the finished ones is fetched again from
// another node; whichever copy arrives first is used. Before anything has finished, the fixed
// delay applies. At most this many extra copies run at once. The lagging node is not blamed,
// its speed estimate just drops to what it has shown so far, so it sinks in the ranking.
const HEDGE_FACTOR = 2;
const HEDGE_MIN_MS = 1500;
const HEDGE_FIRST_MS = 5000;
const HEDGE_MAX_INFLIGHT = 2;
// A chunk keeps being watched until it arrives: when a hedge is due but the job has no hedge
// slot or no free node, it is tried again after HEDGE_RETRY_MS, and a hedge that lags in turn
// gets another copy, up to HEDGE_MAX_COPIES running at once for one chunk.
const HEDGE_RETRY_MS = 500;
const HEDGE_MAX_COPIES = 3;
// A fanout slower than this logs its slowest chunk, with every copy's node and time.
const SLOW_FANOUT_LOG_MS = 4000;
const FANOUT_BUDGET_MS = 25 * 1000;
// A fanout replies only once the whole Range is in, and players give up on a request that
// sends nothing for about two seconds, then ask again: the first download is thrown away.
// A Range the recent fanout speed cannot bring in within this time is swapped instead, so
// the reply streams from its first byte. The speed is forgotten after FANOUT_SPEED_TTL_MS,
// so a slow spell that stopped every fanout does not stop them for good. The first fanouts
// after a pause run on new connections and come out slow, so the speed only turns Ranges
// away once it rests on this many fanouts.
const FANOUT_TARGET_MS = 1500;
const FANOUT_SPEED_TTL_MS = 10 * 60 * 1000;
const FANOUT_MIN_SAMPLES = 3;
// Only some players give up early: AVPlayer-based clients (Apple TV) wait for the whole reply,
// and for them a swap to one slow node is worse than a fanout that answers late. A client is
// known by its User-Agent. A request for a Range whose fanout has run for GIVE_UP_MIN_MS
// without answering counts as giving up; a fanout slower than FANOUT_TARGET_MS that answered
// without such a repeat counts as waited. Every client cancels now and then (a seek drops
// all running requests), so a client is impatient only once it gave up at least
// IMPATIENT_MIN_GIVE_UPS times and at least as often as it waited; only then does
// FANOUT_TARGET_MS apply to it. Some clients (miao) send the same Range twice within a few
// milliseconds, which is why a repeat sooner than GIVE_UP_MIN_MS does not count. Others get
// PATIENT_TARGET_MS, so a fanout too slow to finish within the script's FANOUT_BUDGET_MS is
// swapped up front instead of thrown away at the end. Counts are halved once they pass
// CLIENT_MAX_COUNT, so a client that changes its ways is judged again. The record lives
// under its own key and is read and written in one step, so the fanout that is still running
// cannot overwrite it when it saves its state.
const PATIENT_TARGET_MS = 15 * 1000;
const GIVE_UP_MIN_MS = 1000;
const IMPATIENT_MIN_GIVE_UPS = 3;
const CLIENT_MAX_COUNT = 40;
const CLIENTS_KEY = "bili-ripper.clients";
// Raised whenever the rule for judging a client changes, so counts made under the old rule go.
const CLIENTS_VERSION = 3;
const CLIENT_TTL_MS = 30 * 24 * 60 * 60 * 1000;
const MAX_CLIENTS = 16;
const MAX_RUNNING = 32;
// A Range is split into equal chunks, no larger than ChunkKB, and into up to Threads of them
// while each stays at least this big: 1.1 MB becomes four even chunks, not 1 MB plus a tail.
const MIN_CHUNK_BYTES = 256 * 1024;
// Swap mode spreads files over this many of the best nodes.
const SWAP_SPREAD = 3;

const PRESETS = {
  mainland: [
    "upos-sz-mirrorali.bilivideo.com",
    "upos-sz-mirrorhw.bilivideo.com",
    "upos-sz-mirrorbos.bilivideo.com",
    "upos-sz-mirrorbd.bilivideo.com",
    "upos-sz-mirror14b.bilivideo.com",
    "upos-sz-estgoss.bilivideo.com",
    "upos-sz-mirrorcos.bilivideo.com",
    "upos-sz-mirrorcoso1.bilivideo.com"
  ],
  overseas: [
    "upos-sz-mirrorcosov.bilivideo.com",
    "upos-sz-mirroraliov.bilivideo.com",
    "cn-hk-eq-01-01.bilivideo.com",
    "cn-hk-eq-01-03.bilivideo.com"
  ]
};
PRESETS.all = PRESETS.overseas.concat(PRESETS.mainland);

// Only Bilibili video servers may receive the signed addresses.
const NODE_HOST_RE = /^(?:upos-[a-z0-9-]+\.(?:bilivideo\.com|akamaized\.net)|cn-[a-z0-9-]+\.bilivideo\.com)$/;
const MEDIA_PATH_RE = /^\/(?:upgcxcode|ugaxcode)\/.+\.(?:m4s|mp4|flv)$/;
const URL_RE = /^https:\/\/([^/?#:]+)(?::\d+)?(\/[^?#]*)(\?[^#]*)?/i;
const RANGE_RE = /^bytes=(\d+)-(\d*)$/;
const CONTENT_RANGE_RE = /^bytes (\d+)-(\d+)\/(\d+)$/;

// Request headers that must not be copied onto the chunk requests.
const DROP_FORWARD = ["host", "range", "if-range", "connection", "keep-alive", "content-length",
  "accept-encoding", "transfer-encoding", "te", "upgrade", "proxy-connection", "proxy-authorization"];
// Response headers that describe the chunk rather than the assembled reply.
const DROP_REPLY = ["content-length", "content-range", "content-encoding", "transfer-encoding",
  "connection", "keep-alive"];

// ---- configuration ----

function parseConfig(argument) {
  const raw = {};
  String(argument || "").split("&").forEach((pair) => {
    const at = pair.indexOf("=");
    if (at <= 0) return;
    let value = pair.slice(at + 1).trim();
    try { value = decodeURIComponent(value); } catch (_error) {}
    raw[pair.slice(0, at).trim().toLowerCase()] = value;
  });
  return {
    mode: raw.mode === "swap" ? "swap" : "fanout",
    nodes: parseNodes(raw.nodes),
    threads: clampInt(raw.threads, 1, 32, 8),
    perNode: clampInt(raw.per_node, 1, 8, 3),
    chunkBytes: clampInt(raw.chunk_kb, 128, 8192, 1024) * 1024,
    openRange: raw.open_range === "clip" ? "clip" : "swap",
    maxBytes: clampInt(raw.max_mb, 1, 64, 16) * 1024 * 1024
  };
}

// A preset name, or node hosts separated by "|".
function parseNodes(value) {
  const text = String(value || "").trim().toLowerCase();
  if (PRESETS[text]) return PRESETS[text].slice();
  const hosts = text.split(/[|\s]+/)
    .filter((host, index, all) => NODE_HOST_RE.test(host) && all.indexOf(host) === index);
  return hosts.length ? hosts : PRESETS.mainland.slice();
}

function clampInt(value, min, max, fallback) {
  const number = Math.trunc(Number(value));
  return Number.isFinite(number) && value !== "" ? Math.min(max, Math.max(min, number)) : fallback;
}

// ---- parsing ----

function parseUrl(raw) {
  const match = URL_RE.exec(String(raw || ""));
  return match ? { host: match[1].toLowerCase(), path: match[2], query: match[3] || "" } : null;
}

// Relays (mcdn, PCDN) wrap the file in their own path and signature, so they never match here.
function isMediaUrl(url) {
  return !!url && NODE_HOST_RE.test(url.host) && MEDIA_PATH_RE.test(url.path)
    && !/[?&]os=mcdn(?:&|$)/i.test(url.query);
}

function header(headers, name) {
  const wanted = name.toLowerCase();
  for (const key in headers || {}) {
    if (key.toLowerCase() === wanted) return headers[key];
  }
  return undefined;
}

function parseRange(value) {
  const match = RANGE_RE.exec(String(value || "").trim());
  if (!match) return null;
  const start = Number(match[1]);
  const end = match[2] === "" ? null : Number(match[2]);
  return end === null || end >= start ? { start, end } : null;
}

function parseContentRange(value) {
  const match = CONTENT_RANGE_RE.exec(String(value || "").trim());
  return match ? { start: Number(match[1]), end: Number(match[2]), total: Number(match[3]) } : null;
}

// FNV-1a, so one file keeps landing on the same node.
function hashOf(text) {
  let hash = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash;
}

// ---- shared state ----

function loadState(now) {
  let state = null;
  try { state = JSON.parse($persistentStore.read(STATE_KEY) || "null"); } catch (_error) {}
  if (!state || state.v !== 1) state = { v: 1, nodes: {}, cooldown: 0, assigns: [] };
  if (!state.refused) state.refused = {};
  if (!state.refusals) state.refusals = 0;
  for (const host in state.nodes) {
    const node = state.nodes[host];
    if (node.until <= now) node.until = 0;
  }
  state.assigns = state.assigns.filter((entry) => {
    if (!entry.answered) return now - entry.at < STALE_ASSIGN_MS;
    if (now - entry.answered < RETRY_WINDOW_MS) return true;
    recordNode(state, entry.host, true, 0, now);
    return false;
  });
  for (const dir in state.refused) {
    if (now - state.refused[dir].at > HOSTILE_MS) delete state.refused[dir];
  }
  return state;
}

function saveState(state) {
  try { $persistentStore.write(JSON.stringify(state), STATE_KEY); } catch (_error) {}
}

// ---- clients ----

function loadClients(now) {
  let clients = null;
  try { clients = JSON.parse($persistentStore.read(CLIENTS_KEY) || "null"); } catch (_error) {}
  if (!clients || typeof clients !== "object" || clients.v !== CLIENTS_VERSION) clients = { v: CLIENTS_VERSION };
  const running = Array.isArray(clients.running) ? clients.running : [];
  clients.running = running.filter((entry) => now - entry.at < FANOUT_BUDGET_MS).slice(-MAX_RUNNING);
  const stats = clients.stats && typeof clients.stats === "object" ? clients.stats : {};
  clients.stats = {};
  Object.keys(stats).filter((agent) => now - stats[agent].at < CLIENT_TTL_MS)
    .sort((a, b) => stats[b].at - stats[a].at).slice(0, MAX_CLIENTS)
    .forEach((agent) => { clients.stats[agent] = stats[agent]; });
  return clients;
}

function saveClients(clients) {
  try { $persistentStore.write(JSON.stringify(clients), CLIENTS_KEY); } catch (_error) {}
}

function agentOf(headers) {
  return hashOf(String(header(headers, "user-agent") || "")).toString(36);
}

function isImpatient(clients, agent) {
  const stats = clients.stats[agent];
  return !!stats && stats.gaveUp >= IMPATIENT_MIN_GIVE_UPS && stats.gaveUp >= stats.waited;
}

// Adds one give-up or one wait to a client's counts, logging when its verdict changes.
function countClient(clients, agent, gaveUp, now) {
  const before = isImpatient(clients, agent);
  const stats = clients.stats[agent] || (clients.stats[agent] = { gaveUp: 0, waited: 0, at: 0 });
  if (gaveUp) stats.gaveUp += 1;
  else stats.waited += 1;
  if (stats.gaveUp + stats.waited > CLIENT_MAX_COUNT) {
    stats.gaveUp = Math.floor(stats.gaveUp / 2);
    stats.waited = Math.floor(stats.waited / 2);
  }
  stats.at = now;
  const after = isImpatient(clients, agent);
  if (after !== before) {
    console.log("[bili-ripper] client " + agent + (after ? " gives up on slow replies" : " waits for slow replies")
      + " (gave up " + stats.gaveUp + ", waited " + stats.waited + "): fanouts for it now stay within "
      + (after ? FANOUT_TARGET_MS : PATIENT_TARGET_MS) + "ms");
  }
}

// Notes a request, counting a give-up when the same Range has been fanned out for its client
// for a while and is still running. Returns whether the client is impatient.
function noteClient(agent, key, now) {
  const clients = loadClients(now);
  const abandoned = clients.running.filter((entry) => entry.key === key && entry.agent === agent
    && !entry.abandoned && now - entry.at >= GIVE_UP_MIN_MS);
  if (abandoned.length) {
    abandoned.forEach((entry) => { entry.abandoned = true; });
    countClient(clients, agent, true, now);
    saveClients(clients);
  }
  return isImpatient(clients, agent);
}

function beginFanout(agent, key, now) {
  const clients = loadClients(now);
  const entry = { id: now.toString(36) + Math.random().toString(36).slice(2, 8), agent, key, at: now };
  clients.running.push(entry);
  saveClients(clients);
  return entry;
}

// Ends a fanout; one that answered after FANOUT_TARGET_MS with nobody asking again counts as waited.
function endFanout(entry, answered) {
  const now = Date.now();
  const clients = loadClients(now);
  const current = clients.running.filter((item) => item.id === entry.id)[0];
  if (answered && current && !current.abandoned && now - current.at > FANOUT_TARGET_MS) {
    countClient(clients, entry.agent, false, now);
  }
  clients.running = clients.running.filter((item) => item.id !== entry.id);
  saveClients(clients);
}

function nodeOf(state, host) {
  if (!state.nodes[host]) state.nodes[host] = { bps: 0, at: 0, fail: 0, until: 0 };
  return state.nodes[host];
}

// Two failures in a row ban a node for banMs, doubling with each ban in a row; any success
// clears both counts. A node whose last contact was a failure is marked suspect and ranks
// behind the others until it answers again, so the player is not sent to it first.
function recordNode(state, host, ok, bps, now, reason, banMs) {
  const node = nodeOf(state, host);
  if (ok) {
    node.fail = 0;
    node.bans = 0;
    node.suspect = false;
    if (bps > 0) {
      node.bps = node.bps ? Math.round(node.bps * 0.7 + bps * 0.3) : Math.round(bps);
      node.at = now;
    }
    return;
  }
  node.fail += 1;
  node.seen = now;
  node.suspect = true;
  if (node.fail >= 2) {
    const ms = Math.min((banMs || BAN_MS) * Math.pow(2, node.bans || 0), BAN_MAX_MS);
    node.fail = 0;
    node.bans = (node.bans || 0) + 1;
    node.until = now + ms;
    console.log("[bili-ripper] banned " + host + " for " + (ms >= 60000 ? ms / 60000 + " min" : ms / 1000 + " s")
      + " after " + (reason || "failure") + (node.bans > 1 ? " (ban " + node.bans + " in a row)" : ""));
  }
}

function isSuspect(state, host) {
  return !!(state.nodes[host] && state.nodes[host].suspect);
}

// A 4xx other than 416 (a Range past the end, the request's own fault) is a refusal.
function isRefusal(status) {
  return status >= 400 && status < 500 && status !== 416;
}

// The directory holds every stream of one video, so a refusal of one covers the others.
function dirOf(path) {
  return path.slice(0, path.lastIndexOf("/") + 1);
}

function isHostile(state, path, now) {
  const entry = state.refused[dirOf(path)];
  return !!entry && entry.hosts.length >= 2 && now - entry.at <= HOSTILE_MS;
}

// Notes that a node refused a file. Returns true once the file counts as hostile, and starts
// the cooldown when another video was refused just before: that is the address being throttled.
function noteRefusal(state, path, host, now) {
  const dir = dirOf(path);
  const hostile = isHostile(state, path, now);
  const entry = state.refused[dir] || (state.refused[dir] = { hosts: [], at: 0 });
  if (entry.hosts.indexOf(host) < 0) entry.hosts.push(host);
  entry.at = now;
  const dirs = Object.keys(state.refused).sort((a, b) => state.refused[a].at - state.refused[b].at);
  dirs.splice(0, Math.max(dirs.length - MAX_REFUSED, 0)).forEach((old) => { delete state.refused[old]; });
  if (hostile || !isHostile(state, path, now)) return hostile;
  const others = dirs.filter((other) => other !== dir && state.refused[other].hosts.length >= 2
    && now - state.refused[other].at <= COOLDOWN_MS);
  if (others.length) startCooldown(state, now);
  return true;
}

function startCooldown(state, now) {
  state.refusals = Math.min(state.refusals + 1, COOLDOWN_MAX_DOUBLINGS + 1);
  const ms = COOLDOWN_MS * Math.pow(2, state.refusals - 1);
  state.cooldown = now + ms;
  console.log("[bili-ripper] several videos refused: no fanout for " + ms / 60000 + " min");
}

// Usable nodes, fastest first; never-measured nodes go first so each one gets measured,
// and nodes that failed last go behind every node that did not.
function rankedNodes(config, state, now, exclude) {
  const allowed = config.nodes.filter((host) => exclude.indexOf(host) < 0);
  const healthy = allowed.filter((host) => !(state.nodes[host] && state.nodes[host].until > now));
  const pool = healthy.length ? healthy : allowed.length ? allowed : config.nodes.slice();
  const speed = (host) => (state.nodes[host] && state.nodes[host].bps) || Infinity;
  const suspect = (host) => (isSuspect(state, host) ? 1 : 0);
  return pool.slice().sort((a, b) => suspect(a) - suspect(b)
    || (speed(a) === speed(b) ? 0 : speed(b) > speed(a) ? 1 : -1));
}

function assignKey(url, rangeHeader) {
  return url.path + "|" + (rangeHeader || "");
}

// ---- swap ----

function pickSwapNode(config, state, now, url, exclude) {
  const ranked = rankedNodes(config, state, now, exclude);
  return ranked[hashOf(url.path) % Math.min(SWAP_SPREAD, ranked.length)];
}

// Every node holds the same bytes under its own ETag, so an If-Range carried over from
// another node never matches and the node answers 200 with the whole file instead of a part.
function swappedHeaders(headers, host) {
  const result = {};
  for (const key in headers || {}) {
    const lower = key.toLowerCase();
    if (lower !== "host" && lower !== ":authority" && lower !== "if-range") result[key] = headers[key];
  }
  result.Host = host;
  return result;
}

// ---- fanout ----

function planChunks(start, end, chunkBytes) {
  const chunks = [];
  for (let at = start; at <= end; at += chunkBytes) {
    chunks.push({ start: at, end: Math.min(end, at + chunkBytes - 1), attempts: 0, tried: [], began: {} });
  }
  return chunks;
}

function evenChunkBytes(length, config) {
  const count = Math.max(Math.ceil(length / config.chunkBytes),
    Math.min(config.threads, Math.floor(length / MIN_CHUNK_BYTES)), 1);
  return Math.ceil(length / count);
}

// The largest Range the recent fanout speed brings in within the client's target time;
// Infinity while there is no recent speed or it rests on too few fanouts.
function budgetBytes(state, now, impatient) {
  if (!state.fanoutBps || now - state.fanoutAt > FANOUT_SPEED_TTL_MS) return Infinity;
  if ((state.fanoutSamples || 0) < FANOUT_MIN_SAMPLES) return Infinity;
  return Math.floor(state.fanoutBps * (impatient ? FANOUT_TARGET_MS : PATIENT_TARGET_MS) / 1000);
}

function recordFanout(state, bytes, ms, now) {
  const bps = bytes * 1000 / Math.max(ms, 1);
  const fresh = state.fanoutBps && now - state.fanoutAt <= FANOUT_SPEED_TTL_MS;
  state.fanoutBps = Math.round(fresh ? state.fanoutBps * 0.7 + bps * 0.3 : bps);
  state.fanoutSamples = fresh ? (state.fanoutSamples || 0) + 1 : 1;
  state.fanoutAt = now;
}

// An open Range is answered with this much, so the reply arrives before the player gives up.
function clipBytes(config, state, now, impatient) {
  return Math.min(config.threads * config.chunkBytes * 2, Math.max(budgetBytes(state, now, impatient), config.chunkBytes));
}

function forwardHeaders(headers) {
  const result = {};
  for (const key in headers || {}) {
    const lower = key.toLowerCase();
    if (lower.charAt(0) !== ":" && DROP_FORWARD.indexOf(lower) < 0) result[key] = headers[key];
  }
  result["Accept-Encoding"] = "identity";
  return result;
}

function fetchChunk(job, host, chunk) {
  const headers = Object.assign({}, job.forward, { Range: "bytes=" + chunk.start + "-" + chunk.end });
  const began = Date.now();
  return new Promise((resolve) => {
    $httpClient.get({
      url: "https://" + host + job.target,
      headers,
      timeout: CHUNK_TIMEOUT_S,
      "binary-mode": true
    }, (error, response, data) => {
      if (error || !response) {
        resolve({ ok: false, status: 0, error: String(error || "empty response") });
        return;
      }
      const status = Number(response.status || response.statusCode) || 0;
      const range = parseContentRange(header(response.headers, "content-range"));
      const body = data instanceof Uint8Array ? data : null;
      // A node may answer with another part of the file or a short body: such a reply is dropped.
      const valid = status === 206 && range && body && range.start === chunk.start
        && range.end === Math.min(chunk.end, range.total - 1)
        && body.length === range.end - range.start + 1;
      if (!valid) {
        resolve({ ok: false, status });
        return;
      }
      resolve({
        ok: true, status, headers: response.headers, body, end: range.end, total: range.total,
        bps: body.length * 1000 / Math.max(Date.now() - began, 1)
      });
    });
  });
}

// When the node last answered or failed, so a failing node goes to the back of the probe queue.
function lastContact(state, host) {
  const node = state.nodes[host];
  return node ? Math.max(node.at || 0, node.seen || 0) : 0;
}

function isFresh(state, host, now) {
  const node = state.nodes[host];
  return !!node && node.bps > 0 && now - node.at <= SPEED_TTL_MS;
}

// Fastest expected stream first: a fast node's second slot beats a slow node's first.
// Nodes without a recent measurement are probed one per Range with a single chunk, the
// longest unmeasured first. Only when nothing has a recent measurement do they all run.
function pickChunkNode(job, chunk, freeOnly) {
  const now = Date.now();
  const refused = job.state.refused[dirOf(job.path)];
  const ranked = rankedNodes(job.config, job.state, now, refused ? chunk.tried.concat(refused.hosts) : chunk.tried);
  const load = (host) => job.inflight[host] || 0;
  let pool = ranked;
  if (ranked.some((host) => isFresh(job.state, host, now))) {
    if (!job.probe) {
      const unmeasured = ranked.filter((host) => !isFresh(job.state, host, now));
      if (unmeasured.length) {
        job.probe = unmeasured.sort((a, b) => lastContact(job.state, a) - lastContact(job.state, b))[0];
      }
    }
    pool = ranked.filter((host) => host === job.probe || isFresh(job.state, host, now));
  }
  const limit = (host) => (host === job.probe ? 1 : job.config.perNode);
  const free = pool.filter((host) => load(host) < limit(host));
  if (!free.length) {
    if (freeOnly) return null;
    const measured = pool.filter((host) => host !== job.probe);
    return (measured.length ? measured : pool).slice().sort((a, b) => load(a) - load(b))[0];
  }
  const perStream = (host) => {
    const bps = job.state.nodes[host] && job.state.nodes[host].bps;
    return bps ? bps / (load(host) + 1) : Infinity;
  };
  const suspect = (host) => (isSuspect(job.state, host) ? 1 : 0);
  return free.slice().sort((a, b) => suspect(a) - suspect(b)
    || (perStream(a) === perStream(b) ? 0 : perStream(b) > perStream(a) ? 1 : -1))[0];
}

// Caps a node's speed estimate at what a still-running chunk has achieved so far.
function slowDown(job, host, chunk) {
  const node = nodeOf(job.state, host);
  const elapsed = Math.max(Date.now() - chunk.began[host], 1);
  const shown = Math.round((chunk.end - chunk.start + 1) * 1000 / elapsed);
  if (!node.bps || shown < node.bps) {
    node.bps = shown;
    node.at = Date.now();
  }
}

function hedgeDelay(job) {
  if (!job.durations.length) return HEDGE_FIRST_MS;
  const average = job.durations.reduce((sum, ms) => sum + ms, 0) / job.durations.length;
  return Math.max(HEDGE_MIN_MS, Math.round(average * HEDGE_FACTOR));
}

// Fetches one chunk, starting another copy elsewhere whenever the newest one lags behind the
// others. Resolves with the first good reply, or with the last failure once every copy has
// failed. A copy that is still running when another one wins is left to finish on its own.
function fetchChunkRaced(job, chunk) {
  return new Promise((resolve) => {
    let settled = false;
    let lastLaunch = 0;
    const copies = chunk.copies = [];
    const running = () => copies.filter((copy) => copy.ms === undefined);
    const settle = (result) => {
      settled = true;
      chunk.firstAt = copies[0].began;
      chunk.doneAt = Date.now();
      resolve(result);
    };
    const launch = (host, hedge) => {
      const copy = { host, began: Date.now() };
      copies.push(copy);
      lastLaunch = copy.began;
      chunk.tried.push(host);
      job.inflight[host] = (job.inflight[host] || 0) + 1;
      if (hedge) job.hedges += 1;
      chunk.began[host] = copy.began;
      fetchChunk(job, host, chunk).then((result) => {
        job.inflight[host] -= 1;
        if (hedge) job.hedges -= 1;
        const now = Date.now();
        copy.ms = now - copy.began;
        copy.result = result.ok ? "ok" : result.status ? "HTTP " + result.status : "no reply";
        result.host = host;
        if (result.ok) {
          recordNode(job.state, host, true, result.bps, now);
        } else if (result.status === 416 || (settled && !result.status)) {
          // A Range past the end of the file is the request's fault, not the node's. A copy
          // that lost the race and then got no reply was merely slow, and was marked down for it.
        } else if (isRefusal(result.status)) {
          // The file is blamed once two nodes have refused it; before that, the node is.
          if (!noteRefusal(job.state, job.path, host, now)) {
            recordNode(job.state, host, false, 0, now, "HTTP " + result.status, BAN_MS);
          }
        } else {
          const reason = result.status ? "HTTP " + result.status : "no reply (" + result.error + ")";
          // A name that does not resolve is a node that is gone, not a passing blip.
          const hard = result.status || /\bdns\b/i.test(result.error || "");
          recordNode(job.state, host, false, 0, now, reason, hard ? BAN_MS : BLIP_BAN_MS);
        }
        if (settled) return;
        if (result.ok) {
          job.durations.push(copy.ms);
          settle(result);
        } else if (!running().length) {
          settle(result);
        }
      });
    };
    // One watcher per chunk. The delay depends on chunks that finish later, so it is re-read
    // until it is due; a hedge that cannot start yet is tried again shortly after.
    const watch = () => {
      if (settled || job.aborted) return;
      const now = Date.now();
      const due = lastLaunch + hedgeDelay(job);
      if (now < due) {
        setTimeout(watch, Math.min(due - now, HEDGE_MIN_MS));
        return;
      }
      if (running().length < HEDGE_MAX_COPIES && job.hedges < HEDGE_MAX_INFLIGHT) {
        const host = pickChunkNode(job, chunk, true);
        if (host) {
          running().forEach((copy) => slowDown(job, copy.host, chunk));
          job.hedged += 1;
          launch(host, true);
          setTimeout(watch, Math.min(hedgeDelay(job), HEDGE_MIN_MS));
          return;
        }
      }
      setTimeout(watch, HEDGE_RETRY_MS);
    };
    launch(pickChunkNode(job, chunk, false), false);
    setTimeout(watch, Math.min(hedgeDelay(job), HEDGE_MIN_MS));
  });
}

// Names the chunk that took longest, with the node, time and outcome of each of its copies.
function describeSlowest(job) {
  const slowest = job.done.slice().sort((a, b) => (b.doneAt - b.firstAt) - (a.doneAt - a.firstAt))[0];
  if (!slowest) return "";
  const copies = slowest.copies.map((copy) => copy.host.replace(".bilivideo.com", "") + " "
    + (copy.ms === undefined ? "still running at " + (slowest.doneAt - copy.began) + "ms" : copy.result + " in " + copy.ms + "ms")
    + " (from +" + (copy.began - slowest.firstAt) + "ms)");
  return "slowest chunk " + slowest.start + "-" + slowest.end + " took " + (slowest.doneAt - slowest.firstAt)
    + "ms: " + copies.join(", ");
}

// An abort marked original sends the request to the host Bilibili named instead of a swap.
function abortJob(job, reason, original) {
  if (!job.aborted) {
    job.aborted = new Error(reason);
    job.aborted.original = !!original;
  }
  throw job.aborted;
}

async function worker(job, queue) {
  while (queue.length) {
    if (job.aborted) throw job.aborted;
    const chunk = queue.shift();
    const result = await fetchChunkRaced(job, chunk);
    const now = Date.now();
    if (job.aborted) throw job.aborted;
    if (result.ok) {
      chunk.body = result.body;
      chunk.end = result.end;
      job.total = result.total;
      if (!job.replyHeaders) job.replyHeaders = result.headers;
      job.hosts[result.host] = true;
      job.done.push(chunk);
      continue;
    }
    if (result.status === 416) abortJob(job, "range not satisfiable");
    // Refused by several nodes: only the original host is likely to serve this file.
    if (isHostile(job.state, job.path, now)) abortJob(job, "refused by several nodes", true);
    chunk.attempts = chunk.tried.length;
    if (chunk.attempts >= MAX_ATTEMPTS) abortJob(job, "chunk failed " + chunk.attempts + " times");
    if (now - job.startedAt > FANOUT_BUDGET_MS) abortJob(job, "out of time");
    queue.unshift(chunk);
  }
}

function runChunks(job, chunks) {
  const queue = chunks.slice();
  const workers = Math.min(job.config.threads, queue.length, job.config.nodes.length * job.config.perNode);
  const runs = [];
  for (let i = 0; i < workers; i++) runs.push(worker(job, queue));
  return Promise.all(runs);
}

async function fanout(request, url, config, state, range, impatient) {
  const job = {
    target: url.path + url.query,
    path: url.path,
    forward: forwardHeaders(request.headers),
    config, state,
    inflight: {}, probe: null, hosts: {}, done: [],
    durations: [], hedges: 0, hedged: 0,
    total: 0, replyHeaders: null,
    startedAt: Date.now(), aborted: null
  };
  let end = range.end;
  if (end === null) {
    // The first chunk tells the file size, which an open Range leaves unknown.
    await runChunks(job, planChunks(range.start, range.start + config.chunkBytes - 1, config.chunkBytes));
    end = Math.min(job.total - 1, range.start + clipBytes(config, state, job.startedAt, impatient) - 1);
    const next = job.done[0].end + 1;
    if (next <= end) await runChunks(job, planChunks(next, end, evenChunkBytes(end - next + 1, config)));
  } else {
    await runChunks(job, planChunks(range.start, end, evenChunkBytes(end - range.start + 1, config)));
  }
  end = Math.min(end, job.total - 1);

  const body = new Uint8Array(end - range.start + 1);
  let cursor = range.start;
  job.done.sort((a, b) => a.start - b.start).forEach((chunk) => {
    if (chunk.start !== cursor) throw new Error("gap at " + cursor);
    body.set(chunk.body, chunk.start - range.start);
    cursor = chunk.end + 1;
  });
  if (cursor !== end + 1) throw new Error("short reply");

  const headers = {};
  for (const key in job.replyHeaders) {
    if (DROP_REPLY.indexOf(key.toLowerCase()) < 0) headers[key] = job.replyHeaders[key];
  }
  headers["Content-Range"] = "bytes " + range.start + "-" + end + "/" + job.total;
  headers["Content-Length"] = String(body.length);
  headers["X-Bili-Ripper"] = "fanout chunks=" + job.done.length + " nodes=" + Object.keys(job.hosts).length
    + " hedged=" + job.hedged;
  const ms = Date.now() - job.startedAt;
  recordFanout(state, body.length, ms, Date.now());
  console.log("[bili-ripper] fanout " + Math.round(body.length / 1024) + "KB in " + ms + "ms ("
    + Math.round(body.length / 1.024 / Math.max(ms, 1)) + "KB/s) " + headers["X-Bili-Ripper"].slice(7)
    + (ms > SLOW_FANOUT_LOG_MS ? "; " + describeSlowest(job) : ""));
  return { status: 206, headers, body };
}

function fanoutEligible(request, config, state, range, now, impatient) {
  if (config.mode !== "fanout" || String(request.method || "GET").toUpperCase() !== "GET") return false;
  if (!range || state.cooldown > now) return false;
  if (range.end === null) return config.openRange === "clip";
  const length = range.end - range.start + 1;
  if (length <= config.chunkBytes || length > config.maxBytes) return false;
  if (length <= budgetBytes(state, now, impatient)) return true;
  console.log("[bili-ripper] swapped " + Math.round(length / 1024) + "KB" + (impatient ? "" : " (patient client)") + ": fanout at "
    + Math.round(state.fanoutBps / 1024) + "KB/s would take " + Math.round(length * 1000 / state.fanoutBps) + "ms");
  return false;
}

// ---- hooks ----

function onRequest() {
  const url = parseUrl($request.url);
  if (!isMediaUrl(url)) {
    $done({});
    return;
  }
  const config = parseConfig(typeof $argument === "string" ? $argument : "");
  const now = Date.now();
  const state = loadState(now);
  const rangeHeader = header($request.headers, "range");
  const key = assignKey(url, rangeHeader);

  // A file the nodes refuse is left on the host Bilibili named.
  const original = () => {
    saveState(state);
    $done({});
  };
  if (isHostile(state, url.path, now)) {
    original();
    return;
  }

  // Nodes that refused this file already, and the node that did not answer the same request
  // last time or answered it with headers the player then gave up on, are not tried again for it.
  const refused = state.refused[dirOf(url.path)];
  const exclude = refused ? refused.hosts.slice() : [];
  const stale = state.assigns.filter((entry) => entry.key === key)[0];
  if (stale) {
    const reason = stale.answered ? "the same Range was asked for again after its reply" : "no response to the last request";
    recordNode(state, stale.host, false, 0, now, reason, BLIP_BAN_MS);
    if (exclude.indexOf(stale.host) < 0) exclude.push(stale.host);
    state.assigns = state.assigns.filter((entry) => entry !== stale);
  }

  const host = pickSwapNode(config, state, now, url, exclude);
  const swap = () => {
    state.assigns.push({ key, host, at: Date.now() });
    if (state.assigns.length > MAX_ASSIGNS) state.assigns = state.assigns.slice(-MAX_ASSIGNS);
    saveState(state);
    $done({ url: "https://" + host + url.path + url.query, headers: swappedHeaders($request.headers, host) });
  };

  const range = parseRange(rangeHeader);
  const agent = agentOf($request.headers);
  const impatient = noteClient(agent, key, now);
  if (!fanoutEligible($request, config, state, range, now, impatient)) {
    swap();
    return;
  }
  // Slow chunks must not run into Surge's script timeout: past the budget, swap instead.
  const budget = new Promise((_resolve, reject) => {
    setTimeout(() => reject(new Error("out of time")), FANOUT_BUDGET_MS);
  });
  const running = beginFanout(agent, key, now);
  Promise.race([fanout($request, url, config, state, range, impatient), budget]).then((response) => {
    endFanout(running, true);
    state.refusals = 0;
    saveState(state);
    $done({ response });
  }, (error) => {
    endFanout(running, false);
    const where = error && error.original ? "the original host" : "swap";
    console.log("[bili-ripper] fanout fell back to " + where + ": " + (error && error.message));
    if (error && error.original) original();
    else swap();
  });
}

function onResponse() {
  const url = parseUrl($request.url);
  if (!isMediaUrl(url)) {
    $done({});
    return;
  }
  const now = Date.now();
  const state = loadState(now);
  const key = assignKey(url, header($request.headers, "range"));
  const entry = state.assigns.filter((item) => item.key === key && !item.answered)[0];
  if (entry) {
    const status = Number($response.status || $response.statusCode) || 0;
    const ok = status >= 200 && status < 400;
    if (ok) {
      // Counted as a success once RETRY_WINDOW_MS passes without the same Range coming back.
      entry.answered = now;
    } else {
      // A refusal counts against the file once two nodes have refused it, else against the node.
      if (!isRefusal(status) || !noteRefusal(state, url.path, entry.host, now)) {
        recordNode(state, entry.host, false, 0, now, "HTTP " + status, BAN_MS);
      }
      state.assigns = state.assigns.filter((item) => item !== entry);
    }
    saveState(state);
  }
  $done({});
}

if (typeof $request !== "undefined") {
  if (typeof $response !== "undefined") onResponse();
  else onRequest();
}
