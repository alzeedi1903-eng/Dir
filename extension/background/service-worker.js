/*
 * درع السياق الاستباقي — Service Worker (MV3)
 * الفحص الاستباقي قبل اكتمال التحميل + حجب الروابط الخطرة + شارة المتصفح + سجل التهديدات.
 * الفحص محلي 100%: لا يخرج أي عنوان أو بيانات من الجهاز.
 */
'use strict';

importScripts('/rules/data.js', '/rules/engine.js');

const ENGINE = self.PCS_ENGINE;
const DEFAULT_SETTINGS = {
  blocking: true,
  scanSearch: true,
  scanAllLinks: 'auto',
  useCloud: false,
  cloudEndpoint: ''
};
const LOG_MAX = 500;
const REPORTS_MAX = 200;
const ALLOW_MS = 10 * 60 * 1000; // مدة التجاوز اليدوي: 10 دقائق

/* ================= التهيئة ================= */

chrome.runtime.onInstalled.addListener(async () => {
  const cur = await chrome.storage.local.get(['pcs_settings', 'pcs_stats']);
  const patch = {};
  if (!cur.pcs_settings) patch.pcs_settings = DEFAULT_SETTINGS;
  if (!cur.pcs_stats) patch.pcs_stats = { total: 0, safe: 0, caution: 0, danger: 0, blocked: 0 };
  await chrome.storage.local.set(patch);
  chrome.action.setBadgeBackgroundColor({ color: '#16a34a' });
});

async function getSettings() {
  const { pcs_settings } = await chrome.storage.local.get('pcs_settings');
  return Object.assign({}, DEFAULT_SETTINGS, pcs_settings || {});
}

/* ================= الشارة ================= */

function setBadge(tabId, level) {
  if (!tabId || tabId < 0) return;
  const meta = ENGINE.levels[level] || ENGINE.levels.na;
  try {
    chrome.action.setBadgeText({ tabId, text: meta.icon === '–' ? '' : meta.icon });
    chrome.action.setBadgeBackgroundColor({ tabId, color: meta.color });
  } catch (e) { /* التبويب أُغلق */ }
}

/* ================= السجل والإحصاءات ================= */

async function recordScan(res, action) {
  const { pcs_log = [], pcs_stats } = await chrome.storage.local.get(['pcs_log', 'pcs_stats']);
  const entry = {
    ts: Date.now(),
    url: res.url,
    host: res.registrable || res.host || '',
    score: res.score,
    level: res.level,
    source: res.source || 'direct',
    cloud: res.cloud === true,
    top: res.reasons.slice(0, 3).map(r => r.text),
    action
  };
  pcs_log.push(entry);
  if (pcs_log.length > LOG_MAX) pcs_log.splice(0, pcs_log.length - LOG_MAX);

  const stats = pcs_stats || { total: 0, safe: 0, caution: 0, danger: 0, blocked: 0 };
  stats.total += 1;
  if (res.level === 'safe' || res.level === 'na') stats.safe += 1;
  else if (res.level === 'caution') stats.caution += 1;
  else if (res.level === 'danger') stats.danger += 1;
  if (action === 'blocked') stats.blocked += 1;

  await chrome.storage.local.set({ pcs_log, pcs_stats: stats });
}

/* ================= التجاوز اليدوي (allow-once) ================= */

async function isAllowedOnce(url) {
  const { pcs_allowed = {} } = await chrome.storage.local.get('pcs_allowed');
  const now = Date.now();
  let changed = false;
  for (const u of Object.keys(pcs_allowed)) {
    if (now - pcs_allowed[u] > ALLOW_MS) { delete pcs_allowed[u]; changed = true; }
  }
  if (changed) await chrome.storage.local.set({ pcs_allowed });
  return Object.prototype.hasOwnProperty.call(pcs_allowed, url);
}

async function setAllowedOnce(url) {
  const { pcs_allowed = {} } = await chrome.storage.local.get('pcs_allowed');
  pcs_allowed[url] = Date.now();
  await chrome.storage.local.set({ pcs_allowed });
}

/* ================= وضع السحابة (الخادم السحابي الموحد) ================= */

/* استعلام الخادم الموحد الذي يخدم iOS وAndroid معاً — بمهلة قصيرة حتى لا يبطئ التصفح */
async function cloudScan(url, endpoint) {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), 2500);
  try {
    const r = await fetch(endpoint.replace(/\/+$/, '') +
      '/api/scan?url=' + encodeURIComponent(url) + '&source=extension', { signal: ctl.signal });
    if (!r.ok) throw new Error('cloud http ' + r.status);
    return await r.json();
  } finally {
    clearTimeout(timer);
  }
}

/* دمج نتيجة الخادم مع النتيجة المحلية: الدرجة الأسوأ تحسم، والأسباب تُوحَّد */
function mergeVerdict(local, cloudRes) {
  if (!cloudRes || !cloudRes.ok || !cloudRes.verdict || cloudRes.verdict.scannable === false) return local;
  const v = cloudRes.verdict;
  const CFG = ENGINE.data.config;
  const score = Math.max(local.score || 0, v.score || 0);
  const level = score >= CFG.blockThreshold ? 'danger' : (score > CFG.safeMax ? 'caution' : 'safe');
  const seen = new Set();
  const reasons = [];
  for (const r of (v.reasons || []).concat(local.reasons || [])) {
    const key = r.code + '|' + r.text;
    if (!seen.has(key)) { seen.add(key); reasons.push(r); }
  }
  reasons.sort((a, b) => b.weight - a.weight);
  return Object.assign({}, local, {
    score,
    level,
    levelText: ENGINE.levels[level].text,
    reasons,
    cloud: true
  });
}

/* الفحص الكامل: القواعد المحلية أولاً (فوري)، والخادم السحابي اختيارياً عند تفعيله */
async function analyzeUrl(url, opts) {
  const settings = await getSettings();
  let res = ENGINE.analyze(url, opts);
  if (settings.useCloud && settings.cloudEndpoint && res.scannable !== false) {
    try {
      res = mergeVerdict(res, await cloudScan(url, settings.cloudEndpoint));
    } catch (e) { /* تعذر الوصول للخادم — نستمر بالفحص المحلي دون تعطيل الحماية */ }
  }
  return res;
}

/* ================= الفحص الاستباقي للتنقل ================= */

async function handleNavigation(tabId, url) {
  if (!/^https?:/i.test(url)) {
    setBadge(tabId, 'na');
    return;
  }

  const res = await analyzeUrl(url);
  setBadge(tabId, res.level);

  const settings = await getSettings();
  let action = 'monitored';

  if (res.level === 'danger') {
    if (await isAllowedOnce(url)) {
      action = 'override';
    } else if (settings.blocking) {
      action = 'blocked';
      const page = chrome.runtime.getURL('interstitial/blocked.html') +
        '?t=' + encodeURIComponent(url) + '&s=' + res.score;
      try { chrome.tabs.update(tabId, { url: page }); } catch (e) { /* ignore */ }
    }
  }

  await recordScan(res, action);
}

chrome.webNavigation.onBeforeNavigate.addListener(details => {
  if (details.frameId !== 0) return; // التبويب الرئيسي فقط (الإطارات تتولاها الصفحة)
  handleNavigation(details.tabId, details.url);
});

chrome.tabs.onActivated.addListener(async info => {
  try {
    const tab = await chrome.tabs.get(info.tabId);
    if (tab.url && /^https?:/i.test(tab.url)) {
      const res = await analyzeUrl(tab.url);
      setBadge(tab.id, res.level);
    } else {
      setBadge(tab.id, 'na');
    }
  } catch (e) { /* ignore */ }
});

/* ================= الرسائل (Popup / Content / Interstitial) ================= */

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  (async () => {
    try {
      switch (msg && msg.type) {
        case 'analyze': {
          const res = await analyzeUrl(msg.url, { source: msg.source || 'direct' });
          if (msg.log) await recordScan(res, 'manual');
          sendResponse(res);
          break;
        }
        case 'getSettings':
          sendResponse(await getSettings());
          break;
        case 'setSettings': {
          const cur = await getSettings();
          const next = Object.assign({}, cur, msg.patch || {});
          await chrome.storage.local.set({ pcs_settings: next });
          sendResponse(next);
          break;
        }
        case 'allowOnce':
          await setAllowedOnce(msg.url);
          sendResponse({ ok: true });
          break;
        case 'report': {
          const { pcs_reports = [] } = await chrome.storage.local.get('pcs_reports');
          pcs_reports.push({
            ts: Date.now(),
            url: msg.url,
            score: msg.score != null ? msg.score : null,
            level: msg.level || null,
            note: msg.note || '',
            source: msg.source || 'extension'
          });
          if (pcs_reports.length > REPORTS_MAX) pcs_reports.splice(0, pcs_reports.length - REPORTS_MAX);
          await chrome.storage.local.set({ pcs_reports });
          sendResponse({ ok: true });
          break;
        }
        case 'getDashboard': {
          const data = await chrome.storage.local.get(['pcs_log', 'pcs_stats', 'pcs_reports', 'pcs_settings']);
          sendResponse({
            log: data.pcs_log || [],
            stats: data.pcs_stats || { total: 0, safe: 0, caution: 0, danger: 0, blocked: 0 },
            reports: data.pcs_reports || [],
            settings: Object.assign({}, DEFAULT_SETTINGS, data.pcs_settings || {})
          });
          break;
        }
        case 'clearData':
          await chrome.storage.local.set({
            pcs_log: [],
            pcs_reports: [],
            pcs_stats: { total: 0, safe: 0, caution: 0, danger: 0, blocked: 0 },
            pcs_allowed: {}
          });
          sendResponse({ ok: true });
          break;
        default:
          sendResponse({ ok: false, error: 'unknown message type' });
      }
    } catch (e) {
      sendResponse({ ok: false, error: String(e && e.message || e) });
    }
  })();
  return true; // رد غير متزامن
});
