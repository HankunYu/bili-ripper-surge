const test = require("node:test");
const assert = require("node:assert/strict");
const { createStore, loadFunctions, runHook, createCdn } = require("./harness");

const fn = loadFunctions();
// Values made inside the script's context have that context's prototypes.
const plain = (value) => JSON.parse(JSON.stringify(value));
const MAINLAND = plain(fn.parseNodes("mainland"));
const OVERSEAS = plain(fn.parseNodes("overseas"));
const PATH = "/upgcxcode/99/91/137649199/137649199_da2-1-30032.m4s";
const QUERY = "?e=abc&deadline=1792415496&os=akam&upsig=ffff";
const AKAM_URL = "https://upos-hz-mirrorakam.akamaized.net" + PATH + QUERY;
const KB = 1024;
const MB = 1024 * KB;

function mediaRequest(range, extra = {}) {
  const headers = {
    Host: "upos-hz-mirrorakam.akamaized.net",
    "User-Agent": "Mozilla/5.0 Chrome/130",
    Referer: "https://www.bilibili.com/",
    Origin: "https://www.bilibili.com",
    "Accept-Encoding": "gzip, br"
  };
  if (range) headers.Range = range;
  return Object.assign({ url: AKAM_URL, method: "GET", headers }, extra);
}

function hostOf(url) {
  return /^https:\/\/([^/]+)/.exec(url)[1];
}

function state(store) {
  return JSON.parse(store.read("bili-ripper.state"));
}

test("config falls back to defaults and clamps values", () => {
  const config = fn.parseConfig("mode={{{Mode}}}&threads=999&per_node=0&chunk_kb=&max_mb=8");
  assert.equal(config.mode, "fanout");
  assert.equal(config.threads, 32);
  assert.equal(config.perNode, 1);
  assert.equal(config.chunkBytes, 1024 * KB);
  assert.equal(config.maxBytes, 8 * MB);
  assert.equal(config.openRange, "swap");
  assert.deepEqual(plain(config.nodes), MAINLAND);
  assert.equal(fn.parseConfig("mode=swap&open_range=clip").mode, "swap");
  assert.equal(fn.parseConfig("").threads, 8);
  assert.equal(fn.parseConfig("").perNode, 3);
});

test("the mainland preset no longer lists the retired mirror08c node", () => {
  assert.ok(!MAINLAND.includes("upos-sz-mirror08c.bilivideo.com"));
  assert.ok(!plain(fn.parseNodes("all")).includes("upos-sz-mirror08c.bilivideo.com"));
});

test("custom node list keeps only Bilibili video servers", () => {
  const nodes = fn.parseNodes("upos-sz-mirrorcos.bilivideo.com|evil.example.com|upos-sz-mirrorcos.bilivideo.com|cn-hk-eq-01-01.bilivideo.com");
  assert.deepEqual(plain(nodes), ["upos-sz-mirrorcos.bilivideo.com", "cn-hk-eq-01-01.bilivideo.com"]);
  assert.deepEqual(plain(fn.parseNodes("evil.example.com")), MAINLAND);
  assert.deepEqual(plain(fn.parseNodes("OVERSEAS")), OVERSEAS);
});

test("media URL detection skips relays and other files", () => {
  assert.ok(fn.isMediaUrl(fn.parseUrl(AKAM_URL)));
  assert.ok(fn.isMediaUrl(fn.parseUrl("https://cn-gddg-ct-01-02.bilivideo.com" + PATH + QUERY)));
  assert.ok(!fn.isMediaUrl(fn.parseUrl("https://xy1x2x3x4xy.mcdn.bilivideo.cn:4483" + PATH + QUERY)));
  assert.ok(!fn.isMediaUrl(fn.parseUrl("https://upos-sz-mirrorcos.bilivideo.com" + PATH + "?os=mcdn&x=1")));
  assert.ok(!fn.isMediaUrl(fn.parseUrl("https://upos-sz-mirrorcos.bilivideo.com/bfs/archive/cover.jpg")));
  assert.ok(!fn.isMediaUrl(fn.parseUrl("https://evil.example.com" + PATH)));
});

test("non-media requests are left alone", async () => {
  const result = await runHook({ request: { url: "https://api.bilibili.com/x/player/playurl", headers: {} }, store: createStore() });
  assert.deepEqual(plain(result), {});
});

test("swap mode moves the request to one node and keeps the signature", async () => {
  const store = createStore();
  const first = await runHook({ request: mediaRequest("bytes=0-4095"), argument: "mode=swap", store });
  const host = hostOf(first.url);
  assert.ok(MAINLAND.includes(host));
  assert.equal(first.url, "https://" + host + PATH + QUERY);
  assert.equal(first.headers.Host, host);
  assert.equal(first.headers.Referer, "https://www.bilibili.com/");
  // Same file, same node.
  await runHook({ request: mediaRequest("bytes=0-4095"), response: { status: 206, headers: {} }, store });
  const second = await runHook({ request: mediaRequest("bytes=4096-8191"), argument: "mode=swap", store });
  assert.equal(hostOf(second.url), host);
});

test("fanout assembles a bounded Range from several nodes", async () => {
  const store = createStore();
  const cdn = createCdn(6 * MB, () => "ok", { "Access-Control-Allow-Origin": "https://www.bilibili.com" });
  const result = await runHook({
    request: mediaRequest("bytes=100-3145827"), argument: "threads=4&per_node=1&chunk_kb=512", store, http: cdn.get
  });
  const reply = result.response;
  assert.equal(reply.status, 206);
  assert.equal(reply.headers["Content-Range"], "bytes 100-3145827/" + 6 * MB);
  assert.equal(reply.headers["Content-Length"], String(3145728));
  assert.equal(reply.headers["Access-Control-Allow-Origin"], "https://www.bilibili.com");
  assert.equal(reply.headers["Content-Type"], "video/mp4");
  assert.deepEqual(Buffer.from(reply.body), Buffer.from(cdn.file.slice(100, 3145828)));
  assert.equal(cdn.calls.length, 6);
  // Never-measured nodes are tried first, so the chunks spread past the first four.
  const hosts = new Set(cdn.calls.map((call) => call.host));
  assert.ok(hosts.size >= 4);
  assert.ok(Object.values(cdn.maxInflight).every((count) => count <= 1));
  const sent = cdn.calls[0].options.headers;
  assert.equal(sent["User-Agent"], "Mozilla/5.0 Chrome/130");
  assert.equal(sent.Origin, "https://www.bilibili.com");
  assert.equal(sent["Accept-Encoding"], "identity");
  // HTTP/2 has no Host field; the URL names the node.
  assert.equal(sent.Host, undefined);
  assert.equal(reply.headers["X-Bili-Ripper"], "fanout chunks=6 nodes=" + hosts.size + " hedged=0");
  assert.ok(Object.values(state(store).nodes).some((node) => node.bps > 0));
});

test("fanout retries a chunk elsewhere when a node sends the wrong bytes", async () => {
  const bad = MAINLAND[0];
  const cdn = createCdn(4 * MB, (host) => (host === bad ? "shift" : "ok"));
  const store = createStore();
  const result = await runHook({ request: mediaRequest("bytes=0-2097151"), argument: "chunk_kb=512", store, http: cdn.get });
  assert.equal(result.response.status, 206);
  assert.deepEqual(Buffer.from(result.response.body), Buffer.from(cdn.file.slice(0, 2097152)));
  assert.ok(cdn.calls.length > 4);
});

test("a chunk stuck on one node is fetched again elsewhere and the node sinks in the ranking", async () => {
  const stuck = MAINLAND[0];
  const cdn = createCdn(4 * MB, (host) => (host === stuck ? "hang" : "ok"));
  const store = createStore();
  const began = Date.now();
  const result = await runHook({
    request: mediaRequest("bytes=0-2097151"), argument: "threads=4&per_node=1&chunk_kb=512", store, http: cdn.get
  });
  assert.equal(result.response.status, 206);
  assert.deepEqual(Buffer.from(result.response.body), Buffer.from(cdn.file.slice(0, 2097152)));
  assert.match(result.response.headers["X-Bili-Ripper"], /hedged=1$/);
  // The hedge waited on the finished chunks, not on the 15 s chunk timeout.
  assert.ok(Date.now() - began < 5000);
  const stuckCalls = cdn.calls.filter((call) => call.host === stuck);
  assert.equal(stuckCalls.length, 1);
  const copies = cdn.calls.filter((call) => call.start === stuckCalls[0].start);
  assert.equal(copies.length, 2);
  assert.notEqual(copies[1].host, stuck);
  // Lagging is not a failure, but the node's speed estimate drops to what it has shown.
  const nodes = state(store).nodes;
  assert.equal(nodes[stuck].fail, 0);
  assert.equal(nodes[stuck].until, 0);
  assert.ok(nodes[stuck].bps > 0);
  assert.ok(Object.keys(nodes).filter((host) => host !== stuck).every((host) => nodes[host].bps > nodes[stuck].bps));
});

test("a fast node's second slot is preferred over a slow node's first", async () => {
  const store = createStore();
  const fast = MAINLAND.slice(0, 2);
  const seed = { v: 1, cooldown: 0, assigns: [], nodes: {} };
  MAINLAND.forEach((host) => { seed.nodes[host] = { bps: fast.includes(host) ? 4e6 : 2e5, at: Date.now(), fail: 0, until: 0 }; });
  store.write(JSON.stringify(seed), "bili-ripper.state");
  const cdn = createCdn(4 * MB);
  const result = await runHook({
    request: mediaRequest("bytes=0-2097151"), argument: "threads=4&per_node=2&chunk_kb=512", store, http: cdn.get
  });
  assert.equal(result.response.status, 206);
  assert.ok(cdn.calls.every((call) => fast.includes(call.host)), "chunks went to " + cdn.calls.map((c) => c.host).join());
  assert.ok(Object.values(cdn.maxInflight).every((count) => count <= 2));
});

test("a file refused by two nodes goes to its original host; a second refused video pauses fanout", async () => {
  const store = createStore();
  const one = createCdn(4 * MB, (host) => (host === MAINLAND[0] ? 403 : "ok"));
  const ok = await runHook({ request: mediaRequest("bytes=0-2097151"), argument: "chunk_kb=512", store, http: one.get });
  assert.equal(ok.response.status, 206);
  // The refusing node is not tried again for this file.
  const second = createCdn(4 * MB);
  await runHook({ request: mediaRequest("bytes=2097152-4194303"), argument: "chunk_kb=512", store, http: second.get });
  assert.ok(second.calls.length > 0 && second.calls.every((call) => call.host !== MAINLAND[0]));

  const two = createCdn(4 * MB, () => 403);
  const fallback = await runHook({ request: mediaRequest("bytes=0-2097151"), argument: "chunk_kb=512", store, http: two.get });
  assert.deepEqual(plain(fallback), {});
  // One refused video is that video's problem: fanout goes on for others.
  assert.equal(state(store).cooldown, 0);
  // Every stream of that video now passes through untouched.
  const quiet = createCdn(4 * MB);
  const audio = AKAM_URL.replace("137649199_da2-1-30032.m4s", "137649199-1-30280.m4s");
  const passed = await runHook({ request: mediaRequest("bytes=0-99", { url: audio }), argument: "mode=swap", store, http: quiet.get });
  assert.deepEqual(plain(passed), {});
  assert.equal(quiet.calls.length, 0);

  // A second video refused right after means the address is throttled: fanout pauses.
  const other = AKAM_URL.replace("/99/91/137649199/137649199_da2-1-30032.m4s", "/11/22/137650011/137650011-1-30080.m4s");
  const refused = await runHook({ request: mediaRequest("bytes=0-2097151", { url: other }), argument: "chunk_kb=512", store, http: two.get });
  assert.deepEqual(plain(refused), {});
  const pause = state(store).cooldown - Date.now();
  assert.ok(pause > 110000 && pause <= 120000, String(pause));
  // While cooling down, fanout is skipped entirely.
  const third = AKAM_URL.replace("/99/91/137649199/137649199_da2-1-30032.m4s", "/33/44/137654433/137654433-1-30080.m4s");
  const swapped = await runHook({ request: mediaRequest("bytes=0-2097151", { url: third }), argument: "chunk_kb=512", store, http: quiet.get });
  assert.ok(swapped.url);
  assert.equal(quiet.calls.length, 0);
});

test("the pause doubles while videos keep being refused and resets once a fanout works", async () => {
  const store = createStore();
  store.write(JSON.stringify({ v: 1, cooldown: 0, assigns: [], nodes: {}, refused: {}, refusals: 1 }), "bili-ripper.state");
  const refuse = createCdn(4 * MB, () => 403);
  for (const file of ["/11/22/137650011/137650011-1-30080.m4s", "/33/44/137654433/137654433-1-30080.m4s"]) {
    const url = "https://upos-hz-mirrorakam.akamaized.net/upgcxcode" + file + QUERY;
    await runHook({ request: mediaRequest("bytes=0-2097151", { url }), argument: "chunk_kb=512", store, http: refuse.get });
  }
  const pause = state(store).cooldown - Date.now();
  assert.ok(pause > 230000 && pause <= 240000, String(pause));

  const resumed = state(store);
  resumed.cooldown = 0;
  store.write(JSON.stringify(resumed), "bili-ripper.state");
  const ok = await runHook({ request: mediaRequest("bytes=0-2097151"), argument: "chunk_kb=512", store, http: createCdn(4 * MB).get });
  assert.equal(ok.response.status, 206);
  assert.equal(state(store).refusals, 0);
});

test("no reply bans a node briefly, a server error for longer", async () => {
  const blip = MAINLAND[0];
  const broken = MAINLAND[1];
  const cdn = createCdn(4 * MB, (host) => (host === blip ? "error" : host === broken ? 502 : "ok"));
  const store = createStore();
  // Each Range probes one unmeasured node, so the second failure comes on the next Range.
  const nodes4 = "nodes=" + MAINLAND.slice(0, 4).join("|");
  for (const range of ["bytes=0-2097151", "bytes=2097152-4194303"]) {
    const result = await runHook({ request: mediaRequest(range), argument: nodes4 + "&threads=4&per_node=1&chunk_kb=256", store, http: cdn.get });
    assert.equal(result.response.status, 206);
  }
  const nodes = state(store).nodes;
  const now = Date.now();
  assert.ok(nodes[blip].until > now && nodes[blip].until <= now + 60000, String(nodes[blip].until - now));
  assert.ok(nodes[broken].until > now + 60000 && nodes[broken].until <= now + 300000, String(nodes[broken].until - now));
});

test("stale speeds still rank nodes, and one unmeasured node is probed per Range with one chunk", async () => {
  const store = createStore();
  const fast = MAINLAND.slice(0, 2);
  const slow = MAINLAND[2];
  const seed = { v: 1, cooldown: 0, assigns: [], nodes: {} };
  fast.forEach((host) => { seed.nodes[host] = { bps: 4e6, at: Date.now(), fail: 0, until: 0 }; });
  seed.nodes[slow] = { bps: 1e5, at: Date.now() - 2 * 3600 * 1000, fail: 0, until: 0 };
  store.write(JSON.stringify(seed), "bili-ripper.state");
  const cdn = createCdn(8 * MB);
  const result = await runHook({
    request: mediaRequest("bytes=0-4194303"), argument: "threads=5&per_node=2&chunk_kb=512", store, http: cdn.get
  });
  assert.equal(result.response.status, 206);
  // The first five launches fill the two fast nodes and probe exactly one other node once.
  const opening = cdn.calls.slice(0, 5).map((call) => call.host);
  const probed = opening.filter((host) => !fast.includes(host));
  assert.equal(probed.length, 1, "opened with " + opening.join());
  // A never-measured node is probed before the slow one, whose old speed still counts.
  assert.notEqual(probed[0], slow);
  assert.ok(!cdn.calls.some((call) => call.host === slow));
  assert.ok(Object.values(cdn.maxInflight).every((count) => count <= 2));
});

test("a Range past the end of the file falls back without blaming nodes", async () => {
  const store = createStore();
  const cdn = createCdn(1 * MB);
  const result = await runHook({ request: mediaRequest("bytes=0-3145727"), argument: "chunk_kb=512", store, http: cdn.get });
  assert.ok(result.url);
  assert.ok(Object.values(state(store).nodes).every((node) => node.fail === 0 && node.until === 0));
});

test("small, oversized and open Ranges are swapped by default", async () => {
  const cdn = createCdn(64 * MB);
  for (const range of ["bytes=0-1023", "bytes=0-33554431", "bytes=1024-", undefined]) {
    const result = await runHook({ request: mediaRequest(range), argument: "max_mb=16", store: createStore(), http: cdn.get });
    assert.ok(result.url, String(range));
  }
  assert.equal(cdn.calls.length, 0);
});

test("a Range is split into equal chunks, up to Threads while each stays at least 256 KB", async () => {
  const sizes = (length, argument) => {
    const config = fn.parseConfig(argument);
    return plain(fn.planChunks(0, length - 1, fn.evenChunkBytes(length, config)).map((c) => c.end - c.start + 1));
  };
  // 1.1 MB: four even chunks instead of 1 MB plus a 100 KB tail.
  const small = sizes(1188 * KB, "");
  assert.equal(small.length, 4);
  assert.ok(Math.max(...small) - Math.min(...small) <= 3, String(small));
  // Never larger than ChunkKB, even when that means more chunks than threads.
  assert.deepEqual(sizes(3 * MB, "threads=4&chunk_kb=512"), Array(6).fill(512 * KB));
  assert.equal(sizes(10 * MB, "").length, 10);
  // Each chunk stays at least 256 KB.
  assert.equal(sizes(700 * KB, "chunk_kb=128").length, 6);
  assert.equal(sizes(600 * KB, "threads=8&chunk_kb=1024").length, 2);

  const cdn = createCdn(4 * MB);
  const result = await runHook({ request: mediaRequest("bytes=0-1216511"), store: createStore(), http: cdn.get });
  assert.equal(result.response.headers["Content-Length"], String(1216512));
  assert.equal(cdn.calls.length, 4);
  assert.deepEqual(Buffer.from(result.response.body), Buffer.from(cdn.file.slice(0, 1216512)));
});

test("a Range the recent fanout speed cannot bring in within 1.5 s is swapped", async () => {
  const store = createStore();
  const seed = { v: 1, cooldown: 0, assigns: [], nodes: {}, fanoutBps: 2 * MB, fanoutAt: Date.now() };
  store.write(JSON.stringify(seed), "bili-ripper.state");
  const cdn = createCdn(16 * MB);
  // 4 MB at 2 MB/s would take 2 s.
  const swapped = await runHook({ request: mediaRequest("bytes=0-4194303"), store, http: cdn.get });
  assert.ok(swapped.url);
  assert.equal(cdn.calls.length, 0);
  // 3 MB fits, and the fanout updates the speed.
  const fanned = await runHook({ request: mediaRequest("bytes=0-3145727"), store, http: cdn.get });
  assert.equal(fanned.response.status, 206);
  const after = state(store);
  assert.ok(after.fanoutAt >= seed.fanoutAt);
  assert.notEqual(after.fanoutBps, 2 * MB);

  // An old speed is forgotten: the same 4 MB fans out again.
  const stale = createStore();
  stale.write(JSON.stringify(Object.assign({}, seed, { fanoutAt: Date.now() - 11 * 60 * 1000 })), "bili-ripper.state");
  const again = await runHook({ request: mediaRequest("bytes=0-4194303"), store: stale, http: createCdn(16 * MB).get });
  assert.equal(again.response.status, 206);
  // A fanout with no earlier speed starts the estimate from its own.
  assert.ok(state(stale).fanoutBps > 0);
});

test("clip answers an open Range with a bounded part", async () => {
  const cdn = createCdn(20 * MB);
  const result = await runHook({
    request: mediaRequest("bytes=1000-"), argument: "open_range=clip&threads=2&chunk_kb=512", store: createStore(), http: cdn.get
  });
  const reply = result.response;
  const end = 1000 + 2 * 512 * KB * 2 - 1;
  assert.equal(reply.headers["Content-Range"], "bytes 1000-" + end + "/" + 20 * MB);
  assert.deepEqual(Buffer.from(reply.body), Buffer.from(cdn.file.slice(1000, end + 1)));

  const tiny = createCdn(300 * KB);
  const small = await runHook({ request: mediaRequest("bytes=0-"), argument: "open_range=clip", store: createStore(), http: tiny.get });
  assert.equal(small.response.headers["Content-Range"], "bytes 0-" + (300 * KB - 1) + "/" + 300 * KB);

  // With a recent fanout speed, the part is what that speed brings in within 1.5 s.
  const store = createStore();
  store.write(JSON.stringify({ v: 1, cooldown: 0, assigns: [], nodes: {}, fanoutBps: 2 * MB, fanoutAt: Date.now() }), "bili-ripper.state");
  const timed = await runHook({ request: mediaRequest("bytes=0-"), argument: "open_range=clip&chunk_kb=512", store, http: cdn.get });
  assert.equal(timed.response.headers["Content-Range"], "bytes 0-" + (3 * MB - 1) + "/" + 20 * MB);
});

test("response hook bans a node after repeated failures", async () => {
  const store = createStore();
  const first = await runHook({ request: mediaRequest("bytes=0-1"), argument: "mode=swap", store });
  const host = hostOf(first.url);
  await runHook({ request: mediaRequest("bytes=0-1"), response: { status: 502, headers: {} }, store });
  // One failure already moves the next request elsewhere; only this node is left to fail twice.
  const moved = await runHook({ request: mediaRequest("bytes=2-3"), argument: "mode=swap", store });
  assert.notEqual(hostOf(moved.url), host);
  const only = "mode=swap&nodes=" + host;
  const again = await runHook({ request: mediaRequest("bytes=2-3"), argument: only, store });
  assert.equal(hostOf(again.url), host);
  await runHook({ request: mediaRequest("bytes=2-3"), response: { status: 500, headers: {} }, store });
  assert.ok(state(store).nodes[host].until > Date.now());
  const banned = await runHook({ request: mediaRequest("bytes=4-5"), argument: "mode=swap", store });
  assert.notEqual(hostOf(banned.url), host);
});

test("bans double while a node keeps failing and reset after a success", () => {
  const host = MAINLAND[0];
  const seen = [];
  for (let round = 0; round < 7; round++) {
    const now = round * 1e6;
    const st = { nodes: seen.length ? { [host]: seen[seen.length - 1].node } : {} };
    fn.recordNode(st, host, false, 0, now, "no reply", 60000);
    fn.recordNode(st, host, false, 0, now, "no reply", 60000);
    seen.push({ ms: st.nodes[host].until - now, node: plain(st.nodes[host]) });
  }
  assert.deepEqual(seen.map((s) => s.ms / 60000), [1, 2, 4, 8, 16, 30, 30]);
  const st = { nodes: { [host]: seen[seen.length - 1].node } };
  fn.recordNode(st, host, true, 0, 7e6);
  assert.equal(st.nodes[host].suspect, false);
  fn.recordNode(st, host, false, 0, 8e6, "no reply", 60000);
  fn.recordNode(st, host, false, 0, 8e6, "no reply", 60000);
  assert.equal(st.nodes[host].until - 8e6, 60000);
});

test("a name that does not resolve bans the node as long as a server error", async () => {
  const gone = MAINLAND[0];
  const cdn = createCdn(4 * MB, (host) => (host === gone ? "dns" : "ok"));
  const store = createStore();
  const nodes4 = "nodes=" + MAINLAND.slice(0, 4).join("|");
  for (const range of ["bytes=0-2097151", "bytes=2097152-4194303"]) {
    const result = await runHook({ request: mediaRequest(range), argument: nodes4 + "&threads=4&per_node=1&chunk_kb=256", store, http: cdn.get });
    assert.equal(result.response.status, 206);
  }
  const until = state(store).nodes[gone].until - Date.now();
  assert.ok(until > 60000 && until <= 300000, String(until));
});

test("a node whose last contact failed ranks behind the others until it answers again", () => {
  const config = fn.parseConfig("nodes=" + MAINLAND.slice(0, 3).join("|"));
  const [a, b, c] = MAINLAND;
  const st = { nodes: { [a]: { bps: 9e6, at: 1, fail: 1, until: 0, suspect: true }, [b]: { bps: 2e6, at: 1, fail: 0, until: 0 } } };
  assert.deepEqual(plain(fn.rankedNodes(config, st, 2, [])), [c, b, a]);
  fn.recordNode(st, a, true, 0, 3);
  assert.deepEqual(plain(fn.rankedNodes(config, st, 4, [])), [c, a, b]);
});

test("a swapped request refused by a node moves the file elsewhere, then to its original host", async () => {
  const store = createStore();
  const first = await runHook({ request: mediaRequest("bytes=0-1"), argument: "mode=swap", store });
  const a = hostOf(first.url);
  await runHook({ request: mediaRequest("bytes=0-1"), response: { status: 403, headers: {} }, store });
  const again = await runHook({ request: mediaRequest("bytes=0-1"), argument: "mode=swap", store });
  const b = hostOf(again.url);
  assert.notEqual(b, a);
  await runHook({ request: mediaRequest("bytes=0-1"), response: { status: 404, headers: {} }, store });
  const passed = await runHook({ request: mediaRequest("bytes=2-3"), argument: "mode=swap", store });
  assert.deepEqual(plain(passed), {});
  // A file nobody serves is not held against the nodes.
  const nodes = state(store).nodes;
  assert.equal(nodes[a].until, 0);
  assert.ok(!nodes[b] || nodes[b].until === 0);
});

test("a repeated request without a response moves to another node", async () => {
  const store = createStore();
  const first = await runHook({ request: mediaRequest("bytes=0-99"), argument: "mode=swap", store });
  const retry = await runHook({ request: mediaRequest("bytes=0-99"), argument: "mode=swap", store });
  assert.notEqual(hostOf(retry.url), hostOf(first.url));
  assert.equal(state(store).nodes[hostOf(first.url)].fail, 1);
});
