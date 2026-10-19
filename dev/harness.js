// Runs bili-ripper.js the way Surge does: a fresh context per invocation, with $request,
// $response, $argument, $persistentStore, $httpClient and $done provided from outside.
const fs = require("fs");
const path = require("path");
const vm = require("vm");

const SOURCE = fs.readFileSync(path.join(__dirname, "..", "scripts", "bili-ripper.js"), "utf8");

function createStore() {
  const map = new Map();
  return {
    map,
    read: (key) => (map.has(key) ? map.get(key) : null),
    write: (value, key) => { map.set(key, value); return true; }
  };
}

function createContext(globals) {
  const context = vm.createContext(Object.assign({
    console: { log: () => {} },
    Uint8Array, Promise, Date, Math, JSON, Number, String, Object, Error,
    // Unref'd so a pending budget timer does not hold the test process open.
    setTimeout: (callback, ms) => setTimeout(callback, ms).unref()
  }, globals));
  vm.runInContext(SOURCE, context, { filename: "bili-ripper.js" });
  return context;
}

// Loads the script without a request, so its functions can be called directly.
function loadFunctions() {
  return createContext({ $persistentStore: createStore() });
}

// Runs one hook and resolves with what the script passed to $done.
function runHook({ request, response, argument = "", store, http }) {
  return new Promise((resolve, reject) => {
    const globals = {
      $request: request,
      $argument: argument,
      $persistentStore: store,
      $httpClient: { get: http || (() => reject(new Error("unexpected $httpClient call"))) },
      $done: resolve
    };
    if (response) globals.$response = response;
    try { createContext(globals); } catch (error) { reject(error); }
  });
}

// A fake CDN serving one file. behaviour(host, range) may return "ok", a status number,
// "error", "shift" (wrong part of the file) or "short" (truncated body).
function createCdn(size, behaviour = () => "ok", replyHeaders = {}) {
  const file = new Uint8Array(size);
  for (let i = 0; i < size; i++) file[i] = (i * 31 + 7) & 0xff;
  const cdn = { file, calls: [], inflight: {}, maxInflight: {} };
  cdn.get = (options, callback) => {
    const host = /^https:\/\/([^/]+)/.exec(options.url)[1];
    const match = /^bytes=(\d+)-(\d+)$/.exec(options.headers.Range);
    const start = Number(match[1]);
    const end = Number(match[2]);
    cdn.calls.push({ host, start, end, options });
    cdn.inflight[host] = (cdn.inflight[host] || 0) + 1;
    cdn.maxInflight[host] = Math.max(cdn.maxInflight[host] || 0, cdn.inflight[host]);
    setImmediate(() => {
      cdn.inflight[host] -= 1;
      const verdict = behaviour(host, start, end);
      if (verdict === "error") return callback("connection reset", null, null);
      if (typeof verdict === "number") return callback(null, { status: verdict, headers: {} }, new Uint8Array(0));
      if (start >= size) return callback(null, { status: 416, headers: {} }, new Uint8Array(0));
      const last = Math.min(end, size - 1);
      const from = verdict === "shift" ? start + 1 : start;
      const to = verdict === "short" ? last - 1 : last;
      callback(null, {
        status: 206,
        headers: Object.assign({
          "Content-Range": "bytes " + start + "-" + last + "/" + size,
          "Content-Length": String(to - from + 1),
          "Content-Type": "video/mp4"
        }, replyHeaders)
      }, file.slice(from, to + 1));
    });
  };
  return cdn;
}

module.exports = { createStore, loadFunctions, runHook, createCdn };
