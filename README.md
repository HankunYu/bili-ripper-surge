# Bili Ripper for Surge

在 Surge 网关上给海外看 B 站提速：把视频请求挪到指定的 upos 节点，并把一个 Range 拆成几块、同时从多个节点下载后拼回去。思路和节点表来自 [Bilibili-thread-ripper](https://github.com/MrTangLuyao/Bilibili-thread-ripper)（MIT）。网关后面的设备（浏览器、iOS/iPad App、电视）都不用装东西，只要信任 Surge 的 MITM 证书。

不绕过会员、地区、清晰度或签名限制，只处理你本来就能拿到的地址。

## 工作方式

| 模式 | 做什么 | 代价 |
| --- | --- | --- |
| `swap` | 只把请求的 host 换成选中的节点，响应照常流式返回 | 几乎没有 |
| `fanout`（默认） | 有界 Range（`bytes=a-b`）均分成若干块（每块不超过 `ChunkKB`），最多 `Threads` 个请求同时打到不同节点，校验 `Content-Range` 和长度后拼成一个 206 | 要等整段下完才返回，首字节晚一些 |

- 同一个文件固定落在少数几个节点上（按 path hash），测过的节点按速度排序。测速一小时内算新鲜；过期的不清零，仍按旧速度排，但每个 Range 会拿一块去重测一个最久没碰的节点（没测过的最先），所以慢节点最多拖慢一块、还有补发兜底，不会再把整个 Range 摊到它头上。只有一个新鲜节点都没有时才全体并发。最近一次联系以失败告终的节点排在所有没失败的节点后面，直到它再次成功应答为止，所以 swap 不会把播放器先送到一个刚失败过的节点上。
- 一块比已经完成的块慢两倍以上（至少 1.5 秒；一块都没完成时等 5 秒）就再向另一个节点要一份，谁先回用谁，同时最多补发两份。被追赶的节点不算失败，只是速度估计降到它目前实际表现出来的值，排名自然靠后；挂住的连接因此不用等满 15 秒超时，慢但能用的节点也不会被误封。
- 选节点按"每条流的预期速度"排：快节点的第二个并发位优先于慢节点的第一个，所以 `PerNode` 调高比加 `Threads` 更划算。
- 节点连续失败两次就封：返回错误状态码或域名解析不到的封 5 分钟，完全没回复（连接失败、超时）的只封 1 分钟，日志里会带上具体错误。连着被封时每次翻倍（1、2、4、8…分钟，最长 30 分钟），成功一次就重新从头算，所以一个彻底下线的节点不会每分钟被撞一次。`Bili Ripper Health` 脚本看响应状态，没有响应就重发的请求也算一次失败。有的节点会回一个正常的 206 头然后不给数据，播放器两三秒后放弃重发，所以 swap 的正常状态码要等 10 秒内同一个 Range 没有再被请求才算成功；10 秒内重发就算这个节点失败，重发的请求换到别的节点。swap 会去掉 `If-Range`：每个节点给同一个文件的 ETag 都不一样，带着别的节点的 ETag 过去会对不上，节点就会回 200 和整个文件。补发赢了之后原来那份再超时不算失败。
- 一个节点 4xx 拒绝某个视频后，这个视频不再分给它；两个节点都拒绝，说明这个文件只有 B 站指定的主机肯给，之后 10 分钟内这个视频（音视频流都算）直接放行原主机，节点也不因此被封。
- 2 分钟内两个不同的视频都被这样拒绝，说明 B 站在限流这个 IP：fanout 停 2 分钟，期间只做 swap；连着发生就停 4、8 分钟，fanout 成功一次后重新从 2 分钟起算。
- fanout 任何一步失败都回退到 swap（被多个节点拒绝的回退到原主机），不会让请求直接失败。
- 切块是均分的：块数取「按 `ChunkKB` 切要几块」和「`Threads` 个、但每块不小于 256 KB」里大的那个，所以 1.1 MB 会切成 4 块各约 300 KB 并行下，而不是 1 MB 加一个 100 KB 的尾巴。
- 播放器一个请求大约 2 秒收不到字节就会放弃重发，fanout 要整段下完才回，超过这个时间那份就白下了（日志里对应 Surge 主日志的 `Stream was already closed`）。所以脚本记着最近 fanout 的整体速度（10 分钟内有效，至少要有 3 次 fanout 才生效，因为隔了一阵之后头几次要重新建连接，测出来偏慢），预计 1.5 秒内下不完的 Range 直接 swap，让数据边下边给，脚本日志里是 `swapped NKB: fanout at …KB/s would take …ms`。没有近期速度时只看 `MaxMB`。
- 太小（不到两块）、太大（超过 `MaxMB`）或开放的 Range（`bytes=a-`）默认只 swap。`OpenRange=clip` 时开放 Range 会先取一块拿到文件大小，再返回 `Threads × ChunkKB × 2` 字节的 206（有近期速度时不超过 1.5 秒能下完的量）。这依赖播放器自己续读剩下的部分，属于实验功能。
- P2P/PCDN 中转（`mcdn.bilivideo.cn/com/net`、`szbdyd.com`、`xycdn.com`、`mountaintoys.cn`、`nexusedgeio.com`、`ahdohpiechei.com`，与上游一致）默认 REJECT，逼客户端用 upos 备用地址。QUIC 也会被拒，让客户端走 TCP，这样才能被 MITM。

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
| `PerNode` | `3` | 同一节点同时几个请求 |
| `ChunkKB` | `1024` | 每块最大大小 |
| `OpenRange` | `swap` | `swap` 或 `clip` |
| `MaxMB` | `16` | 超过这个大小的 Range 只 swap（按速度预计超过 1.5 秒的也会 swap） |
| `PCDN` | `REJECT` | 改成 `DIRECT` 就放行 PCDN |

默认 8 线程配 `PerNode=3`：海外看的时候往往只有两三个节点真正快，`PerNode=1` 会强制把线程摊到慢节点上，每个 Range 都要等最慢那块；`PerNode=3` 让 8 条流基本都落在最快的几个节点上。实测（英国，`Nodes=all`）单个好节点约 1.8 MB/s，fanout 平均 4 到 6 MB/s。B 站 CDN 有防盗链，一个 IP 短时间请求太多会被所有节点 403 大约一分钟；如果脚本日志里经常出现 `several videos refused`，就把 `Threads` 调回 4。

`Threads` 不要开得太大：播放器会同时请求视频流和音频流的好几个 Range，峰值可能有四个 Range 一起 fanout，总流数是 `Threads` 的好几倍，链路一旦挤满，每条流都慢，追赶机制还会补发更多。

## 怎么确认在工作

- 浏览器开发者工具 → Network，看 `.m4s` 请求的响应头：fanout 返回的带 `X-Bili-Ripper: fanout chunks=N nodes=M hedged=K`，`K` 是补发过的块数；被 swap 的请求会出现在 Surge 请求记录里，连向新的 host。
- Surge 脚本日志里的 `[bili-ripper] fanout fell back to swap: …` 和 `fell back to the original host: …` 是回退原因，`banned … after …` 是封节点的原因，`several videos refused: no fanout for N min` 是限流暂停。
- 节点测速、封禁和被拒绝的视频都存在 `$persistentStore` 的 `bili-ripper.state` 里。

## 开发

```sh
node --test dev/bili-ripper.test.js    # unit tests with a fake CDN, no network
node dev/live.js '<m4s url>' bytes=0-4194303 'threads=8&per_node=3'   # one real run
```

`dev/harness.js` 按 Surge 的方式加载脚本：每次调用都是新的上下文，`$request`、`$response`、`$argument`、`$persistentStore`、`$httpClient`、`$done` 由外部提供。`live.js` 一次只跑一个请求，别循环跑，否则会触发上面说的 403 限流。

## 致谢

- [MrTangLuyao/Bilibili-thread-ripper](https://github.com/MrTangLuyao/Bilibili-thread-ripper)（MIT）：多线程分片、多 CDN 调度的思路，大陆/海外节点表和 PCDN 中转识别规则都来自这个项目。本项目把它从浏览器油猴脚本移植到 Surge 网关上。
