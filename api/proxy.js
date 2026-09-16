/* api/proxy.js — same-origin relay for sources that block browsers.
   Allowlisted so strangers can't use your function as an open proxy. */
const ALLOWED = new Set([
  'futures.kraken.com',
  'query1.finance.yahoo.com',
  'query2.finance.yahoo.com',
  'api.elections.kalshi.com',
  'farside.co.uk',
  'www.deribit.com',
  'api.kraken.com',            /* used only for the liveness probe */
]);

export default async function handler(req, res) {
  try {
    const raw = Array.isArray(req.query.url) ? req.query.url[0] : req.query.url;
    if (!raw) return res.status(400).json({ error: 'missing ?url=' });
    const u = new URL(raw);
    if (u.protocol !== 'https:' || !ALLOWED.has(u.host))
      return res.status(403).json({ error: 'host not allowed' });

    const r = await fetch(u.toString(), {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36',
        'Accept': 'application/json, text/html;q=0.9, */*;q=0.8',
        'Accept-Language': 'en-US,en;q=0.9',
      },
    });
    const body = await r.text();
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Content-Type', r.headers.get('content-type') || 'text/plain; charset=utf-8');
    res.setHeader('Cache-Control', 'public, max-age=0, s-maxage=60, stale-while-revalidate=300');
    return res.status(r.status).send(body);
  } catch (e) {
    return res.status(502).json({ error: 'upstream failed' });
  }
}