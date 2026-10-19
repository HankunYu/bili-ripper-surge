// Runs one request through bili-ripper.js against the real CDN, with $httpClient backed by
// Node's https. Usage: node dev/live.js <media url> [range] [argument]
// Keep it to a single run at a time: Bilibili throttles bursts from one address.
const https = require("https");
const { createStore, runHook } = require("./harness");

const [mediaUrl, range = "bytes=0-4194303", argument = "threads=8&per_node=1&chunk_kb=1024"] = process.argv.slice(2);
if (!mediaUrl) {
  console.error("usage: node dev/live.js <media url> [range] [argument]");
  process.exit(1);
}

function get(options, callback) {
  const request = https.get(options.url, { headers: options.headers, timeout: options.timeout * 1000 }, (response) => {
    const parts = [];
    response.on("data", (part) => parts.push(part));
    response.on("end", () => {
      const body = Buffer.concat(parts);
      callback(null, { status: response.statusCode, headers: response.headers }, new Uint8Array(body.buffer, body.byteOffset, body.length));
    });
  });
  request.on("timeout", () => request.destroy(new Error("timeout")));
  request.on("error", (error) => callback(String(error), null, null));
}

const calls = [];
function tracedGet(options, callback) {
  const began = Date.now();
  get(options, (error, response, data) => {
    calls.push({ host: /^https:\/\/([^/]+)/.exec(options.url)[1], range: options.headers.Range, status: response ? response.status : error, ms: Date.now() - began, bytes: data ? data.length : 0 });
    callback(error, response, data);
  });
}

(async () => {
  const store = createStore();
  const began = Date.now();
  const result = await runHook({
    request: {
      url: mediaUrl,
      method: "GET",
      headers: {
        "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130 Safari/537.36",
        Referer: "https://www.bilibili.com/",
        Origin: "https://www.bilibili.com",
        Range: range
      }
    },
    argument,
    store,
    http: tracedGet
  });
  const seconds = (Date.now() - began) / 1000;
  for (const call of calls) console.log(call.status, call.host.padEnd(36), call.range.padEnd(24), call.ms + "ms", call.bytes + "B");
  if (result.response) {
    const bytes = result.response.body.length;
    console.log("fanout", result.response.status, result.response.headers["Content-Range"], result.response.headers["X-Bili-Ripper"]);
    console.log(`${bytes} bytes in ${seconds.toFixed(2)}s = ${(bytes / 1048576 / seconds).toFixed(2)} MB/s`);
  } else {
    console.log("fell back to swap:", result.url && /^https:\/\/([^/]+)/.exec(result.url)[1]);
  }
  console.log("state", store.read("bili-ripper.state"));
})();
