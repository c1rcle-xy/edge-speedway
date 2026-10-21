# 边缘函数 · 多站点测速自动跳转

一个单文件、零依赖的边缘函数：访客打开你的边缘函数域名时，它会并发测速环境变量里配置的多个站点，然后 **302 跳转到延迟最低的那个**，并保留原始路径与查询串。

适合场景：同一套站点部署在多个地区/多个 CDN（香港、日本、新加坡…），想让访客自动落到最快的那一台。

```
访客 → 边缘函数 → 并发探测 A/B/C → 选中延迟最低的 B → 302 到 B/原路径
```

## 快速开始

### 1. 部署

**控制台方式（推荐，不用装任何工具）**

1. 打开 [Cloudflare Dashboard](https://dash.cloudflare.com/) → **Workers & Pages** → **Create** → **Worker**
2. 起个名字（比如 `edge-speedway`），创建后点 **Edit code**
3. 把 `edge-speedway.js` 全文粘贴进去，点 **Deploy**

**命令行方式**

```bash
npm i -g wrangler
wrangler login
wrangler deploy
```

### 2. 在控制台手动设置跳转域名

仓库里**不存放任何域名**，站点列表只在 Cloudflare 控制台配置：

> Workers & Pages → 选中你的 Worker → **Settings / 设置** → **Variables and Secrets / 变量和机密** → **Add / 添加**

- 变量名：`TARGETS`
- 值：跳转域名列表，**每行一个**

```ini
香港=https://hk.example.com
日本=https://jp.example.com
新加坡=https://sg.example.com
```

点 **Save and Deploy** 生效。之后访问 Worker 的域名，就会自动跳到测速最快的那一台。

> **为什么不用 `wrangler.toml` 写这些变量？**
> `wrangler deploy` 时，`wrangler.toml` 里的 `[vars]` 是普通环境变量的唯一来源，一次命令行部署会把你控制台手动加的普通变量**覆盖掉**。
> 所以本仓库的 `wrangler.toml` 刻意留空。若你希望命令行部署也绝对碰不到这份配置，可以在控制台把 `TARGETS` 存成 **Secret / 机密**——wrangler 不会改动机密变量。

域名写法的细节：也支持逗号分隔、分号分隔，或者 JSON 数组 `["https://a.com","https://b.com"]`；
`名称=` 前缀是可选的，只用于调试输出和跳转提示页展示；不写协议时默认补 `https://`。

## 环境变量

全部在 Cloudflare 控制台的 **Variables and Secrets / 变量和机密** 里手动设置，仓库内不含任何域名。
除 `TARGETS` 外都不是必填，没设置的项自动使用下表默认值。

| 变量 | 默认 | 说明 |
| --- | --- | --- |
| `TARGETS` | — | **必填，控制台手动配置**。站点列表，换行 / 逗号 / 分号 / JSON 数组均可 |
| `FALLBACK` | 列表第一项 | 全部站点探测失败时的兜底，可填 URL 或列表序号（从 1 开始） |
| `MODE` | `edge` | `edge` 边缘侧测速；`client` 交给浏览器测速（更贴近真实用户体验） |
| `PROBES` | `3` | 探测轮数，上限 5 |
| `TIMEOUT` | `2000` | 单次探测超时（毫秒） |
| `ROUND_GAP` | `60` | 每轮之间的间隔（毫秒） |
| `BUDGET` | `4000` | 测速总预算（毫秒），超时即用已有结果决策 |
| `METHOD` | `HEAD` | 探测方法，`HEAD` 或 `GET` |
| `BUST` | `false` | 为 `true` 时给探测加随机参数绕开缓存（测得更接近回源耗时） |
| `PRESERVE_PATH` | `true` | 是否把访问路径与查询串拼到目标站点后面 |
| `MEMO_SECONDS` | `0` | 同一机房复用上次结论的秒数，`1~300`；开启后二次访问几乎零耗时 |
| `REDIRECT_STATUS` | `302` | 跳转状态码 |
| `HTML` | `false` | 返回带测速结果列表的过渡页（无 JS 也能跳，适合排查） |
| `DEBUG` | `false` | 常驻返回测量明细 JSON |

## 调试参数

| 参数 | 作用 |
| --- | --- |
| `?__edge_debug=1` | 返回各站点的中位数、最小值、每次采样明细 |
| `?__edge_to=2` | 强制跳转到列表第 2 个站点（只接受列表内序号，不是开放重定向） |
| `?__edge_to=0` | 不测速，直接跳列表第一个 |

控制参数统一 `__edge_*` 前缀，在生成跳转地址时会被自动剥离，不会污染目标站点的业务参数。

## 两种测速模式怎么选

- **`MODE=edge`（默认）**：在边缘节点上测「边缘 → 站点」。没有首屏开销，但测的不是访客的网络。站点都在同一区域、或各站点线路差异体现在回源上时够用。
- **`MODE=client`**：返回一个极简页面，由浏览器用 `no-cors` 并发探测再 `location.replace`。测的是「访客 → 站点」的真实时延，跨地区、跨运营商场景更准，代价是首屏多出一个测速页面（约几十到几百毫秒）。

## 其他平台

`edge-speedway.js` 同时提供两种入口：

- `export default { fetch }` —— Cloudflare Workers、Deno Deploy、Vercel Edge 等
- `addEventListener('fetch', …)` —— Service Worker 风格的边缘运行时（如腾讯云 EdgeOne 边缘函数）

后者这些运行时不通过函数参数传环境变量，文件末尾的 `readEnv(event)` 会依次尝试 `event.context.env`、`event.env`、`event.context.environment`、`globalThis.env`。若你的平台挂在别处，改这一处即可。

## 已知取舍

- 探测所用的 `fetch` 无法测量 TCP 握手或 ICMP，测的是「请求到首字节」的时间，通常足以区分线路优劣。
- 默认 `HEAD` 探测走的是站点自身的 CDN 缓存，反映的是线路质量；想要回源耗时把 `BUST` 设为 `true`。
- 别把边缘函数自己的域名写进 `TARGETS`，会自己跳自己形成死循环。

## License

MIT
