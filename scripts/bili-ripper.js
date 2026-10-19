// Bili Ripper for Surge.
// Moves Bilibili media requests onto chosen upos nodes and, in fanout mode, downloads one
// Range from several nodes at once. Node lists and relay detection follow
// Bilibili-thread-ripper (MIT, MrTangLuyao).
//
// One file serves two hooks: http-request (swap / fanout) and http-response (node health).

const STATE_KEY = "bili-ripper.state";
const BAN_MS = 5 * 60 * 1000;
// Bilibili refuses every node for about a minute after a burst from one address.
const COOLDOWN_MS = 2 * 60 * 1000;
// A measured speed older than this is forgotten, so a node that was slow once is tried again.
const SPEED_TTL_MS = 10 * 60 * 1000;
// A swapped request that got no response within this window is counted against its node.
const STALE_ASSIGN_MS = 30 * 1000;
const MAX_ASSIGNS = 64;
const MAX_ATTEMPTS = 3;
const CHUNK_TIMEOUT_S = 15;
const FANOUT_BUDGET_MS = 25 * 1000;
// Swap mode spreads files over this many of the best nodes.
const SWAP_SPREAD = 3;

const PRESETS = {
  mainland: [
    "upos-sz-mirrorali.bilivideo.com",
    "upos-sz-mirrorhw.bilivideo.com",
    "upos-sz-mirrorbos.bilivideo.com",
    "upos-sz-mirror08c.bilivideo.com",
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
    threads: clampInt(raw.threads, 1, 32, 4),
    perNode: clampInt(raw.per_node, 1, 8, 1),
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
  for (const host in state.nodes) {
    const node = state.nodes[host];
    if (node.until <= now) node.until = 0;
    if (now - node.at > SPEED_TTL_MS) node.bps = 0;
  }
  state.assigns = state.assigns.filter((entry) => now - entry.at < STALE_ASSIGN_MS);
  return state;
}

function saveState(state) {
  try { $persistentStore.write(JSON.stringify(state), STATE_KEY); } catch (_error) {}
}

function nodeOf(state, host) {
  if (!state.nodes[host]) state.nodes[host] = { bps: 0, at: 0, fail: 0, until: 0 };
  return state.nodes[host];
}

// Two failures in a row ban a node for a while; any success clears the count.
function recordNode(state, host, ok, bps, now) {
  const node = nodeOf(state, host);
  if (ok) {
    node.fail = 0;
    if (bps > 0) {
      node.bps = node.bps ? Math.round(node.bps * 0.7 + bps * 0.3) : Math.round(bps);
      node.at = now;
    }
    return;
  }
  node.fail += 1;
  if (node.fail >= 2) {
    node.fail = 0;
    node.until = now + BAN_MS;
  }
}

// Usable nodes, fastest first; never-measured nodes go first so each one gets measured.
function rankedNodes(config, state, now, exclude) {
  const allowed = config.nodes.filter((host) => exclude.indexOf(host) < 0);
  const healthy = allowed.filter((host) => !(state.nodes[host] && state.nodes[host].until > now));
  const pool = healthy.length ? healthy : allowed.length ? allowed : config.nodes.slice();
  const speed = (host) => (state.nodes[host] && state.nodes[host].bps) || Infinity;
  return pool.slice().sort((a, b) => (speed(a) === speed(b) ? 0 : speed(b) > speed(a) ? 1 : -1));
}

function assignKey(url, rangeHeader) {
  return url.path + "|" + (rangeHeader || "");
}

// ---- swap ----

function pickSwapNode(config, state, now, url, exclude) {
  const ranked = rankedNodes(config, state, now, exclude);
  return ranked[hashOf(url.path) % Math.min(SWAP_SPREAD, ranked.length)];
}

function swappedHeaders(headers, host) {
  const result = {};
  for (const key in headers || {}) {
    const lower = key.toLowerCase();
    if (lower !== "host" && lower !== ":authority") result[key] = headers[key];
  }
  result.Host = host;
  return result;
}

// ---- fanout ----

function planChunks(start, end, chunkBytes) {
  const chunks = [];
  for (let at = start; at <= end; at += chunkBytes) {
    chunks.push({ start: at, end: Math.min(end, at + chunkBytes - 1), attempts: 0, tried: [] });
  }
  return chunks;
}

// An open Range is answered with this much, so the reply arrives before the player gives up.
function clipBytes(config) {
  return config.threads * config.chunkBytes * 2;
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
  const headers = Object.assign({}, job.forward, { Host: host, Range: "bytes=" + chunk.start + "-" + chunk.end });
  const began = Date.now();
  return new Promise((resolve) => {
    $httpClient.get({
      url: "https://" + host + job.target,
      headers,
      timeout: CHUNK_TIMEOUT_S,
      "binary-mode": true
    }, (error, response, data) => {
      if (error || !response) {
        resolve({ ok: false, status: 0 });
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

function pickChunkNode(job, chunk) {
  const ranked = rankedNodes(job.config, job.state, Date.now(), chunk.tried);
  const free = ranked.filter((host) => (job.inflight[host] || 0) < job.config.perNode);
  if (free.length) return free[0];
  return ranked.slice().sort((a, b) => (job.inflight[a] || 0) - (job.inflight[b] || 0))[0];
}

function abortJob(job, reason) {
  if (!job.aborted) job.aborted = new Error(reason);
  throw job.aborted;
}

async function worker(job, queue) {
  while (queue.length) {
    if (job.aborted) throw job.aborted;
    const chunk = queue.shift();
    const host = pickChunkNode(job, chunk);
    job.inflight[host] = (job.inflight[host] || 0) + 1;
    const result = await fetchChunk(job, host, chunk);
    job.inflight[host] -= 1;
    const now = Date.now();
    if (job.aborted) throw job.aborted;
    if (result.ok) {
      recordNode(job.state, host, true, result.bps, now);
      chunk.body = result.body;
      chunk.end = result.end;
      job.total = result.total;
      if (!job.replyHeaders) job.replyHeaders = result.headers;
      job.hosts[host] = true;
      job.done.push(chunk);
      continue;
    }
    // A Range past the end of the file is the request's fault, not the node's.
    if (result.status === 416) abortJob(job, "range not satisfiable");
    recordNode(job.state, host, false, 0, now);
    if (result.status === 403) job.refusedBy[host] = true;
    // Refusals from several nodes mean Bilibili is throttling this address: back off entirely.
    if (Object.keys(job.refusedBy).length >= 2) {
      job.state.cooldown = now + COOLDOWN_MS;
      abortJob(job, "refused by several nodes");
    }
    chunk.attempts += 1;
    chunk.tried.push(host);
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

async function fanout(request, url, config, state, range) {
  const job = {
    target: url.path + url.query,
    forward: forwardHeaders(request.headers),
    config, state,
    inflight: {}, refusedBy: {}, hosts: {}, done: [],
    total: 0, replyHeaders: null,
    startedAt: Date.now(), aborted: null
  };
  let end = range.end;
  if (end === null) {
    // The first chunk tells the file size, which an open Range leaves unknown.
    await runChunks(job, planChunks(range.start, range.start + config.chunkBytes - 1, config.chunkBytes));
    end = Math.min(job.total - 1, range.start + clipBytes(config) - 1);
    const next = job.done[0].end + 1;
    if (next <= end) await runChunks(job, planChunks(next, end, config.chunkBytes));
  } else {
    await runChunks(job, planChunks(range.start, end, config.chunkBytes));
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
  headers["X-Bili-Ripper"] = "fanout chunks=" + job.done.length + " nodes=" + Object.keys(job.hosts).length;
  return { status: 206, headers, body };
}

function fanoutEligible(request, config, state, range, now) {
  if (config.mode !== "fanout" || String(request.method || "GET").toUpperCase() !== "GET") return false;
  if (!range || state.cooldown > now) return false;
  if (range.end === null) return config.openRange === "clip";
  const length = range.end - range.start + 1;
  return length > config.chunkBytes && length <= config.maxBytes;
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

  // The same request again with no response for the last one: that node did not answer.
  const exclude = [];
  const stale = state.assigns.filter((entry) => entry.key === key)[0];
  if (stale) {
    recordNode(state, stale.host, false, 0, now);
    exclude.push(stale.host);
    state.assigns = state.assigns.filter((entry) => entry !== stale);
  }

  const host = pickSwapNode(config, state, now, url, exclude);
  const passThrough = () => {
    state.assigns.push({ key, host, at: Date.now() });
    if (state.assigns.length > MAX_ASSIGNS) state.assigns = state.assigns.slice(-MAX_ASSIGNS);
    saveState(state);
    $done({ url: "https://" + host + url.path + url.query, headers: swappedHeaders($request.headers, host) });
  };

  const range = parseRange(rangeHeader);
  if (!fanoutEligible($request, config, state, range, now)) {
    passThrough();
    return;
  }
  // Slow chunks must not run into Surge's script timeout: past the budget, swap instead.
  const budget = new Promise((_resolve, reject) => {
    setTimeout(() => reject(new Error("out of time")), FANOUT_BUDGET_MS);
  });
  Promise.race([fanout($request, url, config, state, range), budget]).then((response) => {
    saveState(state);
    $done({ response });
  }, (error) => {
    console.log("[bili-ripper] fanout fell back to swap: " + (error && error.message));
    passThrough();
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
  const entry = state.assigns.filter((item) => item.key === key)[0];
  if (entry) {
    const status = Number($response.status || $response.statusCode) || 0;
    recordNode(state, entry.host, status >= 200 && status < 400, 0, now);
    state.assigns = state.assigns.filter((item) => item !== entry);
    saveState(state);
  }
  $done({});
}

if (typeof $request !== "undefined") {
  if (typeof $response !== "undefined") onResponse();
  else onRequest();
}
