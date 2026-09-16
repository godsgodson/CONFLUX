/* api/proxy.js — relay v3 : direct → Jina reader → Wayback cascade for Farside */

const ALLOWED = new Set([
  'futures.kraken.com',
  'query1.finance.yahoo.com',
  'query2.finance.yahoo.com',
  'api.elections.kalshi.com',
  'farside.co.uk',
  'www.deribit.com',
  'api.kraken.com',
]);

const HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36',
  'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
  'Accept-Language': 'en-US,en;q=0.9',
  'sec-ch-ua': '"Not/A)Brand";v="8", "Chromium";v="126", "Google Chrome";v="126"',
  'sec-ch-ua-mobile': '?0',
  'sec-ch-ua-platform': '"Windows"',
  'Sec-Fetch-Dest': 'document',
  'Sec-Fetch-Mode': 'navigate',
  'Sec-Fetch-Site': 'none',
  'Sec-Fetch-User': '?1',
  'Upgrade-Insecure-Requests': '1',
};

const RETRYABLE = new Set([403, 408, 425, 429, 500, 502, 503, 504, 520, 521, 522, 523, 524]);
const sleep = ms => new Promise(r => setTimeout(r, ms));

/* warm-instance cache — Farside is daily data, 10 min of memoizing is free */
const memo = new Map();
const MEMO_HOSTS = new Set(['farside.co.uk']);
const MEMO_TTL = 10 * 60 * 1000;

async function hit(url) {
  const r = await fetch(url, { headers: HEADERS, signal: AbortSignal.timeout(9000), redirect: 'follow' });
  const body = await r.text();
  const challenged = r.status === 403 &&
    /__cf_chl|Just a moment|cf-browser-verification|challenge-platform/i.test(body);
  return { status: r.status, body, challenged, type: r.headers.get('content-type') || 'text/html; charset=utf-8' };
}

/* layer 2 — Jina Reader: real headless Chrome, usually passes Cloudflare */
async function viaJina(url) {
  const r = await fetch('https://r.jina.ai/' + url, {
    headers: { ...HEADERS, 'X-Return-Format': 'html' },
    signal: AbortSignal.timeout(13000),
  });
  if (!r.ok) return null;
  const body = await r.text();
  return body && body.length > 500 ? { status: 200, body, type: 'text/html; charset=utf-8' } : null;
}

/* layer 3 — Wayback Machine: newest good snapshot (id_ = original unmodified HTML) */
async function viaWayback(url) {
  const base = url.replace(/\/+$/, '');
  const cdx = 'https://web.archive.org/cdx/search/cdx?url=' + encodeURIComponent(base) +
    '&matchType=prefix&output=json&limit=-8&filter=statuscode:200&fl=timestamp,original&collapse=digest';
  let rows = [];
  try {
    const r = await fetch(cdx, { signal: AbortSignal.timeout(9000) });
    if (r.ok) rows = await r.json();
  } catch (e) { return null; }
  const caps = (Array.isArray(rows) ? rows : [])
    .map(x => Array.isArray(x) && /^\d{14}$/.test(x[0]) ? { ts: x[0], url: x[1] } : null)
    .filter(Boolean)
    .reverse();                                   /* newest first */
  for (const c of caps.slice(0, 3)) {
    try {
      const snap = await hit('https://web.archive.org/web/' + c.ts + 'id_/' + c.url);
      if (snap.status === 200 && snap.body.length > 500) return snap;
    } catch (e) {}
  }
  return null;
}

export default async function handler(req, res) {
  try {
    const raw = Array.isArray(req.query.url) ? req.query.url[0] : req.query.url;
    if (!raw) return res.status(400).json({ error: 'missing ?url=' });
    const u = new URL(raw);
    if (u.protocol !== 'https:' || !ALLOWED.has(u.host))
      return res.status(403).json({ error: 'host not allowed' });

    const key = u.toString();
    if (MEMO_HOSTS.has(u.host)) {
      const m = memo.get(key);
      if (m && Date.now() - m.ts < MEMO_TTL) {
        res.setHeader('Access-Control-Allow-Origin', '*');
        res.setHeader('Content-Type', m.type);
        res.setHeader('X-Etf-Source', m.src);
        return res.status(200).send(m.body);
      }
    }

    let out = null, src = 'direct';

    if (u.host === 'farside.co.uk') {
      /* 1 — direct with full browser headers (CF 403s return fast, so retries are cheap) */
      for (let a = 0; a < 2 && !out; a++) {
        try { out = await hit(key); } catch (e) { out = null; }
        if (out && (out.status !== 200 || out.challenged)) out = null;
        if (!out && a === 0) await sleep(900);
      }
      /* 2 — Jina reader */
      if (!out) { try { const j = await viaJina(key); if (j) { out = j; src = 'jina'; } } catch (e) {} }
      /* 3 — Wayback */
      if (!out) { try { const w = await viaWayback(key); if (w) { out = w; src = 'wayback'; } } catch (e) {} }
    } else {
      /* every other host: the proven retry loop */
      for (let a = 0; a < 3; a++) {
        try { out = await hit(key); } catch (e) { out = { status: 504, body: '', challenged: false, type: 'text/plain' }; }
        if ((out.status === 200 && !out.challenged) || !RETRYABLE.has(out.status)) break;
        await sleep(a === 0 ? 700 : 1600);
      }
    }

    const ok = out && out.status === 200 && !out.challenged;
    if (ok && MEMO_HOSTS.has(u.host)) memo.set(key, { ts: Date.now(), body: out.body, type: out.type, src });

    res.setHeader('Access-Control-Allow-Origin', '*');
    if (!ok) return res.status(502).json({ error: 'upstream refused' });
    res.setHeader('Content-Type', out.type);
    res.setHeader('X-Etf-Source', src);
    res.setHeader('Cache-Control', 'public, max-age=0, s-maxage=60, stale-while-revalidate=300');
    return res.status(200).send(out.body);
  } catch (e) {
    return res.status(500).json({ error: 'relay failed' });
  }
}
