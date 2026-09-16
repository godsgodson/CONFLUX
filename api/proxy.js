/* api/proxy.js — relay v2: retries, Cloudflare-challenge detection, Farside memo cache */
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
  'Accept': 'text/html,application/xhtml+xml,application/json;q=0.9,*/*;q=0.8',
  'Accept-Language': 'en-US,en;q=0.9',
};
const RETRYABLE = new Set([403, 408, 425, 429, 500, 502, 503, 504, 520, 521, 522, 523, 524]);
const sleep = ms => new Promise(r => setTimeout(r, ms));

/* warm-instance memory cache — Farside is daily data, 10 min is free */
const memo = new Map();
const MEMO_HOSTS = new Set(['farside.co.uk']);
const MEMO_TTL = 10 * 60 * 1000;

async function fetchUpstream(url) {
  const r = await fetch(url, { headers: HEADERS, signal: AbortSignal.timeout(8000) });
  const body = await r.text();
  const challenged = r.status === 403 && /__cf_chl|Just a moment|cf-browser-verification/i.test(body);
  return { status: r.status, body, challenged, type: r.headers.get('content-type') || 'text/plain; charset=utf-8' };
}

export default async function handler(req, res) {
  try {
    const raw = Array.isArray(req.query.url) ? req.query.url[0] : req.query.url;
    if (!raw) return res.status(400).json({ error: 'missing ?url=' });
    const u = new URL(raw);
    if (u.protocol !== 'https:' || !ALLOWED.has(u.host))
      return res.status(403).json({ error: 'host not allowed' });

    if (MEMO_HOSTS.has(u.host)) {
      const m = memo.get(u.toString());
      if (m && Date.now() - m.ts < MEMO_TTL) {
        res.setHeader('Access-Control-Allow-Origin', '*');
        res.setHeader('Content-Type', m.type);
        return res.status(200).send(m.body);
      }
    }

    let out = null;
    for (let attempt = 0; attempt < 3; attempt++) {
      try { out = await fetchUpstream(u.toString()); }
      catch (e) { out = { status: 504, body: '', challenged: false, type: 'text/plain' }; }
      if ((out.status === 200 && !out.challenged) || !RETRYABLE.has(out.status)) break;
      await sleep(attempt === 0 ? 700 : 1600);   /* Cloudflare bursts usually clear on attempt 2 */
    }

    const ok = out && out.status === 200 && !out.challenged;
    if (ok && MEMO_HOSTS.has(u.host)) memo.set(u.toString(), { ts: Date.now(), body: out.body, type: out.type });

    res.setHeader('Access-Control-Allow-Origin', '*');
    if (!ok) return res.status(502).json({ error: 'upstream refused', upstream: out && out.status });
    res.setHeader('Content-Type', out.type);
    res.setHeader('Cache-Control', 'public, max-age=0, s-maxage=60, stale-while-revalidate=300');
    return res.status(200).send(out.body);
  } catch (e) {
    return res.status(500).json({ error: 'relay failed' });
  }
}
