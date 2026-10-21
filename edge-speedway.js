/**
 * edge-speedway.js —— 边缘函数：多站点并发测速 + 自动跳转到最快站点
 * 运行环境：Cloudflare Workers（ES Module 语法），单文件、零依赖
 *
 * ── 工作原理 ────────────────────────────────────────────────
 * 1. 从环境变量 TARGETS 读取站点列表
 * 2. 每轮对所有站点同时发起一次探测请求（HEAD），共 PROBES 轮，
 *    取中位数作为该站点延迟；全部并发是为了让各站点在同等条件下比较
 * 3. 选出延迟最低的站点，302 跳转过去（可保留原始路径与查询串）
 * 4. 全部失败时回退到列表第一个（或 FALLBACK 指定项）
 *
 * ── 环境变量 ────────────────────────────────────────────────
 * TARGETS        必填。站点列表，支持换行 / 逗号 / 分号 / JSON 数组；
 *                可写成 "香港=https://hk.example.com" 形式给站点起名
 * FALLBACK       全失败时的兜底站点（URL 或列表中的序号，从 1 开始）
 * MODE           edge（默认，边缘侧测速）| client（浏览器侧测速，更贴近真实体验）
 * PROBES         探测轮数，默认 3（上限 5）
 * TIMEOUT        单次探测超时 ms，默认 2000
 * ROUND_GAP      轮次间隔 ms，默认 60
 * BUDGET         测速总预算 ms，默认 4000，超时即用已有结果决策
 * METHOD         HEAD（默认）| GET
 * BUST           true 时加随机参数绕开缓存（默认 false）
 * PRESERVE_PATH  是否保留访问路径与查询串，默认 true
 * MEMO_SECONDS   同一机房结果缓存秒数，默认 0（关闭）；1~300 可显著降低首屏耗时
 * REDIRECT_STATUS 默认 302
 * HTML           true 时返回跳转提示页（没 JS 也能跳）
 * DEBUG          true 时始终返回测量明细 JSON
 *
 * ── 调试 ────────────────────────────────────────────────────
 * ?__edge_debug=1   返回各站点延迟明细
 * ?__edge_to=2      强制跳转到列表中第 2 个站点
 * ?__edge_to=0      只跳转、不测速（直连第一个）
 */

// 运行时是否提供 Cache API（Cloudflare Workers 有，其他平台可能没有）
function hasCacheApi() {
  return typeof caches !== 'undefined' && !!caches.default && typeof caches.default.match === 'function';
}

const now = () =>
  typeof performance !== 'undefined' && typeof performance.now === 'function'
    ? performance.now()
    : Date.now();

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function toNum(v, dft) {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? n : dft;
}

function toBool(v, dft) {
  if (v === undefined || v === null || v === '') return dft;
  return /^(1|true|yes|on)$/i.test(String(v).trim());
}

function median(arr) {
  if (!arr.length) return Infinity;
  const s = arr.slice().sort((a, b) => a - b);
  const mid = s.length >> 1;
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

/* ───────────────── 站点列表解析 ───────────────── */

function normalizeTarget(raw) {
  let s = String(raw).trim().replace(/^["']|["']$/g, '');
  if (!s) return null;
  if (s.startsWith('//')) s = 'https:' + s;
  if (!/^[a-z][a-z0-9+.-]*:/i.test(s)) s = 'https://' + s;

  let u;
  try {
    u = new URL(s);
  } catch {
    return null;
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return null;

  const basePath = u.pathname.replace(/\/+$/, '');
  return {
    origin: u.origin,
    // 探测与跳转都以 base 为基准，base 已去掉尾部斜杠
    base: u.origin + basePath,
  };
}

function parseTargets(raw) {
  if (!raw) return [];

  let items = [];
  if (Array.isArray(raw)) {
    items = raw;
  } else {
    const s = String(raw).trim();
    if (s.startsWith('[') || s.startsWith('{')) {
      try {
        const parsed = JSON.parse(s);
        items = Array.isArray(parsed) ? parsed : Object.entries(parsed).map(([k, v]) => k + '=' + v);
      } catch {
        items = s.split(/[\n,;]+/);
      }
    } else {
      items = s.split(/[\n,;]+/);
    }
  }

  const out = [];
  const seen = new Set();

  for (const item of items) {
    if (item === null || item === undefined) continue;

    // 支持 "名称=https://..." 或 {"名称": "https://..."}
    let name = '';
    let url = '';
    if (typeof item === 'string') {
      const eq = item.indexOf('=');
      if (eq > 0 && !/^\s*[a-z][a-z0-9+.-]*:\/\//i.test(item.slice(0, eq))) {
        name = item.slice(0, eq).trim();
        url = item.slice(eq + 1).trim();
      } else {
        url = item.trim();
      }
    } else if (item && typeof item === 'object') {
      name = String(item.name || item.label || item.title || '').trim();
      url = String(item.url || item.target || item.href || '').trim();
    }

    if (!url || url.startsWith('#')) continue;

    const t = normalizeTarget(url);
    if (!t) continue;
    if (seen.has(t.base)) continue;
    seen.add(t.base);

    out.push({
      name: name || t.origin.replace(/^https?:\/\//, ''),
      base: t.base,
      origin: t.origin,
    });
  }

  return out;
}

/* ───────────────── 配置 ───────────────── */

function buildConfig(env, url) {
  const q = url.searchParams;
  const probes = Math.min(5, Math.round(toNum(q.get('__edge_probes') || env.PROBES, 3)));

  return {
    mode: String(env.MODE || 'edge').toLowerCase() === 'client' ? 'client' : 'edge',
    probes: Math.max(1, probes),
    timeout: toNum(env.TIMEOUT, 2000),
    roundGap: toNum(env.ROUND_GAP, 60),
    budget: toNum(env.BUDGET, 4000),
    method: String(env.METHOD || 'HEAD').toUpperCase() === 'GET' ? 'GET' : 'HEAD',
    bust: toBool(env.BUST, false),
    preservePath: toBool(env.PRESERVE_PATH, true),
    memo: Math.min(300, Math.round(toNum(env.MEMO_SECONDS, 0))),
    status: Math.round(toNum(env.REDIRECT_STATUS, 302)),
    html: toBool(env.HTML, false),
    debug: toBool(env.DEBUG, false) || q.get('__edge_debug') === '1',
    fallback: env.FALLBACK,
  };
}

/* ───────────────── 单个探测 ───────────────── */

async function probeOne(target, cfg, timeout) {
  const url = cfg.bust
    ? target.base + (target.base.includes('?') ? '&' : '?') + '_ts=' + Math.random().toString(36).slice(2)
    : target.base;

  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeout);
  const t0 = now();

  try {
    const res = await fetch(url, {
      method: cfg.method,
      redirect: 'follow',
      signal: ctrl.signal,
      headers: {
        'cache-control': 'no-cache',
        pragma: 'no-cache',
        'user-agent': 'Mozilla/5.0 (compatible; edge-speedway/1.0)',
      },
    });

    // 不读取正文，测的是「首字节到达时间」；主动丢弃 body 释放连接
    if (cfg.method !== 'HEAD' && res.body && typeof res.body.cancel === 'function') {
      try {
        await res.body.cancel();
      } catch {}
    }

    return { ok: true, ms: now() - t0, status: res.status };
  } catch (err) {
    return { ok: false, ms: now() - t0, error: String((err && err.message) || err) };
  } finally {
    clearTimeout(timer);
  }
}

/* ───────────────── 并发分批测速 ───────────────── */

async function measureAll(targets, cfg) {
  const stats = targets.map((t) => ({ target: t, samples: [], errors: 0 }));
  const deadline = now() + cfg.budget;

  for (let round = 0; round < cfg.probes; round++) {
    const left = deadline - now();
    if (left < 150) break;
    const slot = Math.max(200, Math.min(cfg.timeout, left));

    const results = await Promise.all(stats.map((s) => probeOne(s.target, cfg, slot)));
    results.forEach((r, i) => {
      if (r.ok) stats[i].samples.push(r.ms);
      else stats[i].errors++;
    });

    if (round < cfg.probes - 1) await sleep(cfg.roundGap);
  }

  for (const s of stats) {
    s.min = s.samples.length ? Math.min(...s.samples) : Infinity;
    s.latency = s.samples.length ? median(s.samples) : Infinity;
    s.ok = s.samples.length > 0;
    s.samples = s.samples.map((v) => Math.round(v));
  }

  // 成功优先，再按中位数、最小时延升序
  stats.sort((a, b) => {
    if (a.ok !== b.ok) return a.ok ? -1 : 1;
    if (a.latency !== b.latency) return a.latency - b.latency;
    return a.min - b.min;
  });

  return stats;
}

/* ───────────────── 目标地址拼装 ───────────────── */

// 去掉 __edge_* 控制参数，只保留业务参数
function cleanRequestPath(url) {
  const kept = new URLSearchParams();
  for (const [k, v] of url.searchParams) {
    if (!k.startsWith('__edge_')) kept.append(k, v);
  }
  const qs = kept.toString();
  return { pathname: url.pathname || '/', search: qs ? '?' + qs : '' };
}

function buildRedirectUrl(target, reqUrl, cfg) {
  const basePath = target.base.slice(target.origin.length); // '' 或 '/xxx'
  const req = cleanRequestPath(reqUrl);

  if (!cfg.preservePath) return target.base || target.origin + '/';
  if (!basePath) return target.origin + req.pathname + req.search;
  if (req.pathname === '/') return target.base;
  return target.base + req.pathname + req.search;
}

/* ───────────────── 结果缓存（同机房） ───────────────── */

function memoKey(req, request) {
  const colo = (request.cf && request.cf.colo) || 'default';
  return 'https://edge-speedway.internal/memo/' + encodeURIComponent(colo);
}

async function memoGet(key) {
  if (!key || !hasCacheApi()) return null;
  try {
    const hit = await caches.default.match(new Request(key));
    return hit ? await hit.json() : null;
  } catch {
    return null;
  }
}

async function memoSet(key, value, ttl) {
  if (!key || !ttl || !hasCacheApi()) return;
  try {
    await caches.default.put(
      new Request(key),
      new Response(JSON.stringify(value), {
        headers: { 'content-type': 'application/json', 'cache-control': 'max-age=' + ttl },
      })
    );
  } catch {}
}

/* ───────────────── 基础渲染 ───────────────── */

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function jsonResponse(data, status = 200) {
  return new Response(JSON.stringify(data, null, 2), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' },
  });
}

const PAGE_STYLE =
  'margin:0;min-height:100vh;display:flex;align-items:center;justify-content:center;' +
  'background:#0f172a;color:#e2e8f0;font:14px/1.7 -apple-system,BlinkMacSystemFont,"Segoe UI",system-ui,sans-serif';

/* 边缘侧已测速完成，返回带 meta refresh 的过渡页（无 JS 也能跳） */
function edgeResultPage(winnerUrl, stats) {
  const rows = stats
    .map((s) => {
      let ms;
      if (s.memo) ms = Math.round(s.latency) + ' ms · 缓存';
      else if (s.ok) ms = Math.round(s.latency) + ' ms';
      else if (s.skipped) ms = '—';
      else ms = '超时';

      const cls = s.memo ? 'hit' : s.ok ? (s === stats[0] ? 'hit' : '') : s.skipped ? '' : 'bad';
      return '<tr class="' + cls + '"><td>' + escapeHtml(s.target.name) + '</td><td>' + ms + '</td></tr>';
    })
    .join('');

  return (
    '<!doctype html><html lang="zh-CN"><head><meta charset="utf-8">' +
    '<meta name="viewport" content="width=device-width,initial-scale=1">' +
    '<meta name="robots" content="noindex">' +
    '<meta http-equiv="refresh" content="0;url=' + escapeHtml(winnerUrl) + '">' +
    '<title>正在进入最快节点…</title><style>body{' + PAGE_STYLE + '}' +
    '.box{width:min(420px,88vw);padding:28px;border:1px solid #1e293b;border-radius:14px;background:#111c33}' +
    'h1{font-size:16px;margin:0 0 14px;font-weight:600}table{width:100%;border-collapse:collapse;font-size:13px}' +
    'td{padding:6px 0;border-bottom:1px solid #1e293b;color:#94a3b8}td:last-child{text-align:right;font-variant-numeric:tabular-nums}' +
    '.hit td{color:#34d399}.bad td{color:#f87171}a{color:#60a5fa;font-size:13px}' +
    '</style></head><body><div class="box"><h1>已选择延迟最低的节点，正在跳转…</h1>' +
    '<table>' + rows + '</table>' +
    '<p style="margin:16px 0 0"><a href="' + escapeHtml(winnerUrl) + '">没有自动跳转？点此进入</a></p>' +
    '</div></body></html>'
  );
}

/* 浏览器侧测速页：在用户真实网络环境里测，最准 */
function clientProbePage(items, cfg) {
  const boot = JSON.stringify(items)
    .replace(/</g, '\\u003c')
    .replace(/>/g, '\\u003e')
    .replace(/&/g, '\\u0026');

  const script =
    'var T=' + boot + ';' +
    'var R=' + cfg.probes + ',TO=' + Math.round(cfg.timeout) + ',GAP=' + Math.round(cfg.roundGap) + ';' +
    'var DEADLINE=Date.now()+' + Math.round(cfg.budget + 1200) + ';' +
    'var box=document.getElementById("rows");' +
    'var st=T.map(function(t){var li=document.createElement("li");' +
    'li.innerHTML="<span>"+t.n+"</span><b>等待中</b>";box.appendChild(li);' +
    'return {i:t,s:[],el:li};});' +
    'function draw(){st.forEach(function(o){o.el.querySelector("b").textContent=' +
    'o.s.length?Math.round(med(o.s))+" ms":"超时";if(o.s.length)o.el.className="ok";else o.el.className="bad";});}' +
    'function med(a){a=a.slice().sort(function(x,y){return x-y});var m=a.length>>1;' +
    'return a.length%2?a[m]:(a[m-1]+a[m])/2;}' +
    'function once(url){return new Promise(function(res){var c=new AbortController();' +
    'var tm=setTimeout(function(){c.abort();},TO);var t0=performance.now();' +
    'fetch(url+(url.indexOf("?")>-1?"&":"?")+"_t="+Math.random().toString(36).slice(2),' +
    '{mode:"no-cors",method:"' + cfg.method + '",cache:"no-store",redirect:"follow",signal:c.signal})' +
    '.then(function(){clearTimeout(tm);res(performance.now()-t0);})' +
    '.catch(function(){clearTimeout(tm);res(null);});});}' +
    'function round(){return Promise.all(st.map(function(o){return once(o.i.u).then(function(ms){' +
    'if(ms!==null)o.s.push(ms);});}));}' +
    'function go(idx){var u=st[idx].i.t;document.getElementById("tip").textContent="正在进入 "+st[idx].i.n+"…";' +
    'location.replace(u);}' +
    'var fallback=T[0].t;' +
    '(async function(){for(var r=0;r<R;r++){if(Date.now()>DEADLINE)break;await round();draw();' +
    'if(r<R-1)await new Promise(function(x){setTimeout(x,GAP);});}' +
    'var best=-1,bv=Infinity;st.forEach(function(o,k){var v=o.s.length?med(o.s):Infinity;if(v<bv){bv=v;best=k;}});' +
    'if(best<0){document.getElementById("tip").textContent="测速全部失败，使用备用线路…";location.replace(fallback);return;}' +
    'st.forEach(function(o,k){o.el.className=k===best?"best":(o.s.length?"ok":"bad");});go(best);})();';

  const links = items.map((it) => '<li><a href="' + escapeHtml(it.t) + '">' + escapeHtml(it.n) + '</a></li>').join('');

  return (
    '<!doctype html><html lang="zh-CN"><head><meta charset="utf-8">' +
    '<meta name="viewport" content="width=device-width,initial-scale=1">' +
    '<meta name="robots" content="noindex"><title>正在选择最快的线路…</title>' +
    '<style>body{' + PAGE_STYLE + '}' +
    '.box{width:min(440px,88vw);padding:28px;border:1px solid #1e293b;border-radius:14px;background:#111c33}' +
    'h1{font-size:16px;margin:0 0 16px;font-weight:600}' +
    'ul{list-style:none;margin:0;padding:0}li{display:flex;justify-content:space-between;gap:12px;' +
    'padding:8px 0;border-bottom:1px solid #1e293b;color:#94a3b8;font-size:13px}' +
    'li b{font-weight:500;font-variant-numeric:tabular-nums;color:#64748b}' +
    'li.ok b{color:#e2e8f0}li.best{color:#34d399}li.best b{color:#34d399}li.bad b{color:#f87171}' +
    '#tip{margin:16px 0 0;font-size:12px;color:#64748b}' +
    'details{margin-top:14px;font-size:12px;color:#64748b}details a{color:#60a5fa;text-decoration:none}' +
    '</style></head><body><div class="box"><h1>正在选择延迟最低的节点…</h1>' +
    '<ul id="rows"></ul><p id="tip">正在并发测速，完成后自动跳转</p>' +
    '<details><summary>手动选择</summary><ul>' + links + '</ul></details>' +
    '</div><script>' + script + '</script></body></html>'
  );
}

/* ───────────────── 主流程 ───────────────── */

function pickFallback(targets, raw) {
  if (raw) {
    const s = String(raw).trim();
    const idx = Number(s);
    if (Number.isInteger(idx) && idx >= 1 && idx <= targets.length) return targets[idx - 1];
    const t = normalizeTarget(s);
    if (t) return { name: t.origin, base: t.base, origin: t.origin };
  }
  return targets[0];
}

async function handle(request, env) {
  const cfg = buildConfig(env || {}, new URL(request.url));
  const url = new URL(request.url);

  const rawList = (env && (env.TARGETS || env.SITES || env.EDGE_TARGETS)) || '';
  const targets = parseTargets(rawList);

  if (!targets.length) {
    return jsonResponse(
      {
        ok: false,
        error: '缺少环境变量 TARGETS',
        hint: '在边缘函数控制台新增环境变量 TARGETS，值为站点列表（换行或逗号分隔），例如：\nhttps://a.example.com\nhttps://b.example.com',
      },
      500
    );
  }

  // 强制指定跳转目标（只允许列表内序号，避免被当作开放重定向）
  const forced = url.searchParams.get('__edge_to');
  if (forced !== null) {
    const idx = Number(forced);
    if (Number.isInteger(idx) && idx >= 1 && idx <= targets.length) {
      const u = buildRedirectUrl(targets[idx - 1], url, cfg);
      return new Response(null, { status: cfg.status, headers: { location: u, 'cache-control': 'no-store' } });
    }
    if (idx === 0) {
      const u = buildRedirectUrl(targets[0], url, cfg);
      return new Response(null, { status: cfg.status, headers: { location: u, 'cache-control': 'no-store' } });
    }
  }

  // HEAD 探针请求不必跑完整测速
  if (request.method === 'HEAD' && !cfg.debug) {
    const fb = pickFallback(targets, cfg.fallback);
    return new Response(null, {
      status: cfg.status,
      headers: { location: buildRedirectUrl(fb, url, cfg), 'cache-control': 'no-store' },
    });
  }

  // 浏览器侧测速：把「探测地址 + 最终跳转地址」都算好再交给页面
  if (cfg.mode === 'client') {
    const items = targets.map((t) => ({
      n: t.name,
      u: t.base,
      t: buildRedirectUrl(t, url, cfg),
    }));
    return new Response(clientProbePage(items, cfg), {
      headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' },
    });
  }

  // 边缘侧测速，先看同机房有没有近期结论
  const mKey = cfg.memo ? memoKey(url, request) : null;
  const started = now();
  let stats = null;
  let cached = false;

  if (mKey) {
    const memo = await memoGet(mKey);
    if (memo && memo.base) {
      const hit = targets.find((t) => t.base === memo.base);
      if (hit) {
        const others = targets.filter((t) => t.base !== memo.base);
        stats = [{ target: hit, ok: true, latency: memo.latency || 0, min: memo.latency || 0, samples: [], errors: 0, memo: true }].concat(
          others.map((t) => ({ target: t, ok: false, latency: Infinity, min: Infinity, samples: [], errors: 0, skipped: true }))
        );
        cached = true;
      }
    }
  }

  if (!stats) {
    stats = await measureAll(targets, cfg);
    const best = stats[0];
    if (best && best.ok && mKey) {
      await memoSet(mKey, { base: best.target.base, latency: Math.round(best.latency) }, cfg.memo);
    }
  }

  const best = stats[0] && stats[0].ok ? stats[0] : null;
  const fbTarget = pickFallback(targets, cfg.fallback);
  const winner = best ? best.target : fbTarget;
  const winnerUrl = buildRedirectUrl(winner, url, cfg);

  if (cfg.debug) {
    return jsonResponse({
      ok: true,
      cached,
      elapsedMs: Math.round(now() - started),
      mode: cfg.mode,
      winner: winner.base,
      redirectTo: winnerUrl,
      ranking: stats.map((s) => ({
        name: s.target.name,
        base: s.target.base,
        ok: s.ok,
        skipped: !!s.skipped,
        memo: !!s.memo,
        latencyMs: s.ok ? Math.round(s.latency) : null,
        minMs: s.ok ? Math.round(s.min) : null,
        samples: s.samples,
        errors: s.errors,
      })),
    });
  }

  if (cfg.html) {
    return new Response(edgeResultPage(winnerUrl, stats), {
      status: 200,
      headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' },
    });
  }

  const status = request.method === 'GET' || request.method === 'HEAD' ? cfg.status : 307;
  return new Response(null, {
    status,
    headers: {
      location: winnerUrl,
      'cache-control': 'no-store, no-cache, must-revalidate',
      'referrer-policy': 'no-referrer',
      'x-edge-speedway': (cached ? 'memo:' : 'probe:') + winner.base + ';ms=' + (best ? Math.round(best.latency) : -1),
      'server-timing': 'speedway;dur=' + Math.round(now() - started),
    },
  });
}

/* ───────────────── 入口 ───────────────── */

// 1) Cloudflare Workers（ES Module 语法）/ Deno Deploy / Vercel Edge
export default {
  async fetch(request, env) {
    try {
      return await handle(request, env);
    } catch (err) {
      return jsonResponse({ ok: false, error: String((err && err.stack) || err) }, 500);
    }
  },
};

export { handle };

// 2) Service Worker 风格运行时（如腾讯云 EdgeOne 边缘函数）：
//    这些环境里没有 `env` 参数，按平台文档取环境变量；
//    若你的平台把变量挂在别处，只需改下面 readEnv 的取值顺序。
function readEnv(event) {
  const candidates = [
    event && event.context && event.context.env,
    event && event.env,
    event && event.context && event.context.environment,
    typeof globalThis !== 'undefined' ? globalThis.env : undefined,
  ];
  for (const c of candidates) {
    if (c && typeof c === 'object') return c;
  }
  return {};
}

if (typeof addEventListener === 'function' && typeof Deno === 'undefined' && typeof Bun === 'undefined') {
  addEventListener('fetch', (event) => {
    if (typeof event.respondWith !== 'function') return;
    event.respondWith(
      handle(event.request, readEnv(event)).catch(
        (err) => new Response('edge-speedway error: ' + String((err && err.message) || err), { status: 500 })
      )
    );
  });
}
