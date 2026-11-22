'use strict';
/* Vercel Function — فحص رابط: GET /api/scan?url=...&source=... أو POST JSON {url, source} */
const core = require('./_lib/core.js');

module.exports = async (req, res) => {
  if (req.method === 'OPTIONS') return core.preflight(res);
  const ip = (req.socket && req.socket.remoteAddress) || 'unknown';
  if (!core.rateOk(ip)) return core.send(res, 429, { ok: false, error: 'rate limit exceeded' });

  let url = req.query && req.query.url;
  let source = req.query && req.query.source;
  if (!url && req.body && typeof req.body === 'object') {
    url = req.body.url;
    source = req.body.source || source;
  }
  const out = await core.scan(url, source);
  return core.send(res, out.status, out.body);
};
