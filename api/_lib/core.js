'use strict';
/*
 * درع الاحتيال — المنطق المشترك لدوال Vercel الخادمية (بدون أي مكتبات خارجية)
 *
 * الفحص نفسه عديم الحالة (دوال نقية فوق المحرك)، وسجل الفحوصات/البلاغات
 * يُحفظ في ذاكرة كل نسخة دالة (ephemeral) — يكفي لتجميع مؤشرات التهديدات
 * أثناء العمل، ويُعاد بناؤه تلقائياً بعد أي إعادة نشر.
 *
 * متغيرات البيئة:
 *   PCS_AI_ENDPOINT  رابط طبقة الذكاء الاصطناعي السياقي (اختياري — المرحلة 3)
 *   PCS_AI_KEY       مفتاح المصادقة للطبقة أعلاه (اختياري)
 */
const ENGINE = require('./engine.js');

const RATE_MAX = 120;            // أقصى طلبات لكل IP في النافذة (لكل نسخة دالة)
const RATE_WINDOW_MS = 60000;
const LOG_CAP = 500;
const REPORTS_CAP = 300;
const START = Date.now();

let scanlog = [];
let reports = [];

/* ============ حد معدل الطلبات ============ */

const hits = new Map();
function rateOk(ip) {
  const now = Date.now();
  let arr = (hits.get(ip) || []).filter(t => now - t < RATE_WINDOW_MS);
  if (arr.length >= RATE_MAX) { hits.set(ip, arr); return false; }
  arr.push(now);
  hits.set(ip, arr);
  if (hits.size > 5000) hits.clear();
  return true;
}

/* ============ HTTP helpers ============ */

function setCors(res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
}

function preflight(res) {
  setCors(res);
  res.statusCode = 204;
  res.end();
}

function send(res, status, body) {
  setCors(res);
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.end(JSON.stringify(body, null, 2));
}

/* ============ أدوات مشتركة ============ */

function normalizeSource(s) {
  const allowed = ['search', 'maps', 'message', 'sms', 'chat', 'whatsapp', 'direct', 'extension', 'web', 'shortcut', 'pwa'];
  s = String(s || '').toLowerCase();
  return allowed.indexOf(s) !== -1 ? s : 'direct';
}

/* المرحلة 3: طبقة الذكاء الاصطناعي السياقي — أي فشل فيها لا يعطل الفحص القاعدي */
async function aiEvaluate(url, source, verdict) {
  const ep = process.env.PCS_AI_ENDPOINT;
  if (!ep) return null;
  try {
    const ctl = new AbortController();
    const t = setTimeout(() => ctl.abort(), 3000);
    const headers = { 'Content-Type': 'application/json' };
    if (process.env.PCS_AI_KEY) headers['Authorization'] = 'Bearer ' + process.env.PCS_AI_KEY;
    const r = await fetch(ep, {
      method: 'POST',
      headers,
      body: JSON.stringify({ url, source, verdict }),
      signal: ctl.signal
    });
    clearTimeout(t);
    if (!r.ok) return null;
    const j = await r.json();
    if (j && (typeof j.adjust === 'number' || typeof j.score === 'number')) return j;
    return null;
  } catch (e) { return null; }
}

function applyAi(verdict, ai) {
  if (!ai) return verdict;
  const adjust = typeof ai.adjust === 'number'
    ? ai.adjust
    : (typeof ai.score === 'number' ? ai.score - verdict.score : 0);
  let score = Math.max(0, Math.min(100, verdict.score + adjust));
  let level, levelText;
  if (score >= ENGINE.data.config.blockThreshold) { level = 'danger'; levelText = 'خطر'; }
  else if (score > ENGINE.data.config.safeMax) { level = 'caution'; levelText = 'مشبوه'; }
  else { level = 'safe'; levelText = 'آمن'; }
  const reasons = verdict.reasons.slice();
  reasons.push({
    code: 'AI',
    text: (ai.reason || 'تعديل طبقة الذكاء الاصطناعي السياقي') +
      ' (' + (adjust >= 0 ? '+' : '') + adjust + ')',
    weight: adjust
  });
  reasons.sort((a, b) => b.weight - a.weight);
  return Object.assign({}, verdict, { score, level, levelText, reasons, ai: true });
}

/* ============ المعالجات ============ */

async function scan(urlParam, source) {
  if (!urlParam) return { status: 400, body: { ok: false, error: 'missing url parameter' } };
  const src = normalizeSource(source);
  const verdict = ENGINE.analyze(urlParam, { source: src });
  const ai = await aiEvaluate(urlParam, src, verdict);
  const final = applyAi(verdict, ai);
  scanlog.push({
    ts: Date.now(),
    url: urlParam,
    host: final.registrable || final.host || '',
    score: final.score,
    level: final.level,
    source: src,
    ai: Boolean(ai)
  });
  if (scanlog.length > LOG_CAP) scanlog.splice(0, scanlog.length - LOG_CAP);
  return {
    status: 200,
    body: {
      ok: true,
      engine: 'pcs-engine@' + ENGINE.version,
      source: src,
      verdict: final,
      display: ENGINE.buildDisplay(final)
    }
  };
}

function report(body) {
  if (!body || !body.url) return { status: 400, body: { ok: false, error: 'missing url' } };
  const entry = {
    id: 'R' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
    ts: Date.now(),
    url: String(body.url),
    level: body.level || null,
    score: typeof body.score === 'number' ? body.score : null,
    note: String(body.note || ''),
    source: normalizeSource(body.source),
    status: 'new'
  };
  reports.push(entry);
  if (reports.length > REPORTS_CAP) reports.splice(0, reports.length - REPORTS_CAP);
  return { status: 200, body: { ok: true, report: entry } };
}

function campaignClusters(entries) {
  const map = {};
  for (const e of entries) {
    if (e.level !== 'caution' && e.level !== 'danger') continue;
    const host = e.host || 'unknown';
    if (!map[host]) map[host] = { domain: host, detections: 0, maxScore: 0, levels: {}, sources: {} };
    const c = map[host];
    c.detections++;
    c.maxScore = Math.max(c.maxScore, e.score || 0);
    c.levels[e.level] = (c.levels[e.level] || 0) + 1;
    const s = e.source || 'direct';
    c.sources[s] = (c.sources[s] || 0) + 1;
  }
  return Object.values(map)
    .sort((a, b) => b.detections - a.detections || b.maxScore - a.maxScore);
}

function threats() {
  return {
    status: 200,
    body: {
      ok: true,
      generator: 'fraud-shield-api@' + ENGINE.version,
      generatedAt: new Date().toISOString(),
      note: 'التجميع من ذاكرة هذه النسخة من الدالة (يُعاد بناؤه بعد إعادة النشر)',
      stats: {
        scans: scanlog.length,
        reports: reports.length,
        danger: scanlog.filter(e => e.level === 'danger').length,
        caution: scanlog.filter(e => e.level === 'caution').length
      },
      campaigns: campaignClusters(scanlog).slice(0, 50),
      recent: scanlog.slice(-100).reverse(),
      reports: reports.slice(-100).reverse()
    }
  };
}

function health() {
  return {
    status: 200,
    body: {
      ok: true,
      service: 'fraud-shield-api',
      version: ENGINE.version,
      uptimeSec: Math.round((Date.now() - START) / 1000),
      scans: scanlog.length,
      reports: reports.length,
      aiHook: Boolean(process.env.PCS_AI_ENDPOINT)
    }
  };
}

module.exports = { preflight, send, rateOk, normalizeSource, scan, report, threats, health };
