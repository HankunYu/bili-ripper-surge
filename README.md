# Bili Ripper for Surge

在 Surge 网关上给海外看 B 站提速：把视频请求挪到指定的 upos 节点，并把一个 Range 拆成几块、同时从多个节点下载后拼回去。思路和节点表来自 [Bilibili-thread-ripper](https://github.com/MrTangLuyao/Bilibili-thread-ripper)（MIT）。网关后面的设备（浏览器、iOS/iPad App、电视）都不用装东西，只要信任 Surge 的 MITM 证书。

不绕过会员、地区、清晰度或签名限制，只处理你本来就能拿到的地址。

## 工作方式

| 模式 | 做什么 | 代价 |
| --- | --- | --- |
| `swap` | 只把请求的 host 换成选中的节点，响应照常流式返回 | 几乎没有 |
| `fanout`（默认） | 有界 Range（`bytes=a-b`）拆成 `ChunkKB` 大小的块，最多 `Threads` 个请求同时打到不同节点，校验 `Content-Range` 和长度后拼成一个 206 | 要等整段下完才返回，首字节晚一些 |

- 同一个文件固定落在少数几个节点上（按 path hash），未测速的节点优先被试，测过的按速度排序，测速 10 分钟后过期重测。
- 节点连续失败两次封 5 分钟；`Bili Ripper Health` 脚本看响应状态，没有响应就重发的请求也算一次失败。
- 两个以上节点同时 403 说明 B 站在限流这个 IP，fanout 停 2 分钟，期间只做 swap。
- fanout 任何一步失败都回退到 swap，不会让请求直接失败。
- 太小（不到两块）、太大（超过 `MaxMB`）或开放的 Range（`bytes=a-`）默认只 swap。`OpenRange=clip` 时开放 Range 会先取一块拿到文件大小，再返回 `Threads × ChunkKB × 2` 字节的 206。这依赖播放器自己续读剩下的部分，属于实验功能。
- P2P/PCDN 中转（`mcdn.bilivideo.cn`、`szbdyd.com`、`mountaintoys.cn`）默认 REJECT，逼客户端用 upos 备用地址。QUIC 也会被拒，让客户端走 TCP，这样才能被 MITM。

## 安装

1. Surge → 模块 → 安装新模块，填 `https://raw.githubusercontent.com/HankunYu/bili-ripper-surge/main/BiliRipper.sgmodule`。
2. 开启 MITM 和脚本。网关后**每台**要提速的设备都要信任 Surge 的 CA。不信任的设备访问这些域名会 TLS 失败，视频放不了。如果你的 Surge 版本支持，可以用 `[MITM]` 里的 `client-source-address` 把 MITM 限定在已装证书的设备上。
3. 需要 Surge 5（模块参数 `#!arguments`、`DOMAIN-WILDCARD`、`binary-body-mode`）。

## 参数

| 参数 | 默认 | 说明 |
| --- | --- | --- |
| `Mode` | `fanout` | `fanout` 或 `swap` |
| `Nodes` | `mainland` | `mainland`、`overseas`、`all`，或用 `\|` 分隔的 host（只接受 `upos-*.bilivideo.com`、`upos-*.akamaized.net`、`cn-*.bilivideo.com`） |
| `Threads` | `8` | 一个 Range 同时发几个块请求 |
| `PerNode` | `1` | 同一节点同时几个请求 |
| `ChunkKB` | `1024` | 每块大小 |
| `OpenRange` | `swap` | `swap` 或 `clip` |
| `MaxMB` | `16` | 超过这个大小的 Range 只 swap |
| `PCDN` | `REJECT` | 改成 `DIRECT` 就放行 PCDN |

默认 8 线程配 `PerNode=1`，正好分到大陆预设的 8–9 个节点上，每个节点只开一个请求。B 站 CDN 有防盗链，一个 IP 短时间请求太多会被所有节点 403 大约一分钟；如果脚本日志里经常出现 `refused by several nodes`，就把 `Threads` 调回 4。

## 怎么确认在工作

- 浏览器开发者工具 → Network，看 `.m4s` 请求的响应头：fanout 返回的带 `X-Bili-Ripper: fanout chunks=N nodes=M`；被 swap 的请求会出现在 Surge 请求记录里，连向新的 host。
- Surge 脚本日志里的 `[bili-ripper] fanout fell back to swap: …` 是回退原因。
- 节点测速和封禁状态存在 `$persistentStore` 的 `bili-ripper.state` 里。

## 开发

```sh
node --test dev/                       # unit tests with a fake CDN, no network
node dev/live.js '<m4s url>' bytes=0-4194303 'threads=4&per_node=1'   # one real run
```

`dev/harness.js` 按 Surge 的方式加载脚本：每次调用都是新的上下文，`$request`、`$response`、`$argument`、`$persistentStore`、`$httpClient`、`$done` 由外部提供。`live.js` 一次只跑一个请求，别循环跑，否则会触发上面说的 403 限流。

## 致谢

- [MrTangLuyao/Bilibili-thread-ripper](https://github.com/MrTangLuyao/Bilibili-thread-ripper)（MIT）：多线程分片、多 CDN 调度的思路，大陆/海外节点表和 PCDN 中转识别规则都来自这个项目。本项目把它从浏览器油猴脚本移植到 Surge 网关上。
