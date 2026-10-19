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
  assert.equal(sent.Host, cdn.calls[0].host);
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

test("one refusing node is worked around, two trigger cooldown and fall back to swap", async () => {
  const store = createStore();
  const one = createCdn(4 * MB, (host) => (host === MAINLAND[0] ? 403 : "ok"));
  const ok = await runHook({ request: mediaRequest("bytes=0-2097151"), argument: "chunk_kb=512", store, http: one.get });
  assert.equal(ok.response.status, 206);

  const two = createCdn(4 * MB, () => 403);
  const fallback = await runHook({ request: mediaRequest("bytes=2097152-4194303"), argument: "chunk_kb=512", store, http: two.get });
  assert.equal(fallback.response, undefined);
  assert.ok(MAINLAND.includes(hostOf(fallback.url)));
  assert.ok(state(store).cooldown > Date.now());

  // While cooling down, fanout is skipped entirely.
  const quiet = createCdn(4 * MB);
  const swapped = await runHook({ request: mediaRequest("bytes=0-1048575", { url: AKAM_URL + "&n=2" }), argument: "chunk_kb=512", store, http: quiet.get });
  assert.ok(swapped.url);
  assert.equal(quiet.calls.length, 0);
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
});

test("response hook bans a node after repeated failures", async () => {
  const store = createStore();
  const first = await runHook({ request: mediaRequest("bytes=0-1"), argument: "mode=swap", store });
  const host = hostOf(first.url);
  await runHook({ request: mediaRequest("bytes=0-1"), response: { status: 403, headers: {} }, store });
  const again = await runHook({ request: mediaRequest("bytes=2-3"), argument: "mode=swap", store });
  assert.equal(hostOf(again.url), host);
  await runHook({ request: mediaRequest("bytes=2-3"), response: { status: 502, headers: {} }, store });
  assert.ok(state(store).nodes[host].until > Date.now());
  const moved = await runHook({ request: mediaRequest("bytes=4-5"), argument: "mode=swap", store });
  assert.notEqual(hostOf(moved.url), host);
});

test("a repeated request without a response moves to another node", async () => {
  const store = createStore();
  const first = await runHook({ request: mediaRequest("bytes=0-99"), argument: "mode=swap", store });
  const retry = await runHook({ request: mediaRequest("bytes=0-99"), argument: "mode=swap", store });
  assert.notEqual(hostOf(retry.url), hostOf(first.url));
  assert.equal(state(store).nodes[hostOf(first.url)].fail, 1);
});
