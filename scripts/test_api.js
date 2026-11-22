'use strict';
/*
 * حصن (Hisn) — اختبارات دوال Vercel الخادمية: node scripts/test_api.js
 * تغطي: /api/scan (GET + POST JSON + POST نص خام + format=text + نقص المعاملات)،
 * /api/report، /api/threats، /api/health، حد المعدل، CORS، وملفات الاختصارات /api/shortcut.
 * صفر dependencies — req/res وهمية وتُرجع رمز خطأ عند أي فشل.
 */
let passed = 0, failed = 0;
function check(name, cond, detail) {
  if (cond) { passed++; return; }
  failed++;
  console.error('  FAIL: ' + name + (detail ? ' — ' + detail : ''));
}

(async () => {

/* ===== محاكاة req/res بلا أي مكتبات ===== */
function mockReq({ method = 'GET', query = {}, body, headers = {}, socketIp = '203.0.113.9' } = {}) {
  return {
    method,
    query,
    body,
    headers,
    socket: { remoteAddress: socketIp },
    __parsedBody: undefined
  };
}
function mockRes() {
  const res = {
    statusCode: 200,
    headers: {},
    chunks: [],
    setHeader(k, v) { res.headers[k.toLowerCase()] = v; },
    end(c) { if (c != null) res.chunks.push(String(c)); }
  };
  res.body = () => res.chunks.join('');
  res.json = () => { try { return JSON.parse(res.body()); } catch (e) { return null; } };
  return res;
}

function freshCore() {
  /* نسخة نظيفة من core لكل مجموعة اختبارات — ويجب تفريغ دوال النهايات أيضاً لأن
     scan.js مثلاً إن بقي مخزّناً فسيحتفظ بإشارة إلى نسخة core القديمة */
  [
    '../api/_lib/core.js',
    '../api/scan.js', '../api/report.js', '../api/threats.js',
    '../api/health.js', '../api/shortcut.js'
  ].forEach(p => { delete require.cache[require.resolve(p)]; });
}

/* ============ 1) /api/scan ============ */
{
  const core = freshCore();
  const scan = require('../api/scan.js');
  const req = mockReq({ query: { url: 'https://adcb-secure-login.com' } });
  const res = mockRes();
  scan(req, res).then(() => {
    const j = res.json();
    check('scan GET → 200', res.statusCode === 200);
    check('scan GET → ok:true', !!(j && j.ok));
    check('scan GET → حكم خطر', j.verdict && j.verdict.level === 'danger');
    check('scan GET → classification عربي', j.classification === 'خطر');
    check('scan GET → official_domain صحيح', j.official_domain === 'adcb.com');
    check('scan GET → display جاهز', typeof j.display === 'string' && j.display.indexOf('🔴') === 0);
    check('scan GET → CORS مفتوح', res.headers['access-control-allow-origin'] === '*');
    check('scan GET → زمن الفحص', j.timing && typeof j.timing.ms === 'number');
  });
}
{
  const core = freshCore();
  const scan = require('../api/scan.js');
  const req = mockReq({ method: 'POST', body: { url: 'https://bit.ly/gift-prize', source: 'shortcut' } });
  const res = mockRes();
  scan(req, res).then(() => {
    const j = res.json();
    check('scan POST JSON → 200', res.statusCode === 200);
    check('scan POST JSON → مصدر shortcut', j.source === 'shortcut');
    check('scan POST JSON → مختصر → مشبوه', j.verdict.level === 'caution');
  });
}
{
  const core = freshCore();
  const scan = require('../api/scan.js');
  /* JSON خام بدون Content-Type — بعد الإصلاح يُفكك النص ويُفحص بدل 400 */
  const req = mockReq({ method: 'POST', body: '{"url":"https://www.emiratesnbd.com","source":"web"}' });
  const res = mockRes();
  scan(req, res).then(() => {
    const j = res.json();
    check('scan POST نص خام → 200 (إصلاح body)', res.statusCode === 200, 'الفعلي ' + res.statusCode);
    check('scan POST نص خام → نطاق رسمي آمن', j.verdict && j.verdict.level === 'safe');
    check('scan POST نص خام → المصدر web', j.source === 'web');
  });
}
{
  const core = freshCore();
  const scan = require('../api/scan.js');
  const req = mockReq({ query: { url: 'https://adcb-secure-login.com', format: 'text' } });
  const res = mockRes();
  scan(req, res).then(() => {
    check('scan format=text → 200', res.statusCode === 200);
    check('scan format=text → محتوى نصي', res.headers['content-type'].indexOf('text/plain') === 0);
    check('scan format=text → يبدأ برمز الخطر', res.body().indexOf('🔴') === 0);
    check('scan format=text → يذكر الموقع الرسمي', res.body().indexOf('adcb.com') !== -1);
    check('scan format=text → لا JSON', res.body().indexOf('{') === -1);
  });
}
{
  const core = freshCore();
  const scan = require('../api/scan.js');
  const res = mockRes();
  scan(mockReq({}), res).then(() => {
    check('scan بلا رابط → 400', res.statusCode === 400);
    check('scan بلا رابط → رسالة خطأ إنجليزية ثابتة', res.json().error === 'missing url parameter');
  });
}
{
  const core = freshCore();
  const scan = require('../api/scan.js');
  const res = mockRes();
  scan(mockReq({ method: 'OPTIONS' }), res).then(() => {
    check('scan OPTIONS → 204', res.statusCode === 204);
    check('scan OPTIONS → CORS', res.headers['access-control-allow-origin'] === '*');
  });
}
{
  const core = freshCore();
  const scan = require('../api/scan.js');
  const res = mockRes();
  scan(mockReq({ query: { url: 'http://192.168.1.5/otp' } }), res).then(() => {
    const j = res.json();
    check('scan IP+otp → خطر عبر الخادم أيضاً', j.verdict.level === 'danger', 'الدرجة ' + (j.verdict && j.verdict.score));
    check('scan IP+otp → النطاق المسجل هو العنوان', j.verdict.registrable === '192.168.1.5');
  });
}

/* ============ 2) /api/report ============ */
{
  const core = freshCore();
  const report = require('../api/report.js');
  const res = mockRes();
  report(mockReq({ method: 'GET' }), res).then(() => {
    check('report GET → 405', res.statusCode === 405);
  });
}
{
  const core = freshCore();
  const report = require('../api/report.js');
  const res = mockRes();
  report(mockReq({
    method: 'POST',
    body: { url: 'https://adcb-secure-login.com', note: 'نطاق مقلد', level: 'danger', source: 'web' }
  }), res).then(() => {
    const j = res.json();
    check('report POST → 200', res.statusCode === 200);
    check('report POST → ok:true', !!(j && j.ok));
    check('report POST → معرف بلاغ يبدأ بـR', typeof j.report.id === 'string' && j.report.id[0] === 'R');
    check('report POST → status جديد', j.report.status === 'new');
  });
}
{
  const core = freshCore();
  const report = require('../api/report.js');
  const res = mockRes();
  report(mockReq({ method: 'POST', body: { note: 'بلا رابط' } }), res).then(() => {
    check('report بلا url → 400', res.statusCode === 400);
  });
}

/* ============ 3) /api/threats و /api/health ============ */
{
  const core = freshCore();
  const scan = require('../api/scan.js');
  const threats = require('../api/threats.js');
  /* تغذية سجل قبل التجميع */
  await scan(mockReq({ query: { url: 'https://adcb-secure-login.com', source: 'message' } }), mockRes());
  await scan(mockReq({ query: { url: 'https://adcb-secure-login.com', source: 'message' } }), mockRes());
  const threatsRes = mockRes();
  await threats(mockReq({}), threatsRes);
  const j = threatsRes.json();
  check('threats → 200 وok', threatsRes.statusCode === 200 && j.ok === true);
  check('threats → عدّاد فحوص 2', j.stats.scans === 2, 'الفعلي ' + j.stats.scans);
  check('threats → حملة مجمعة للنطاق', j.campaigns.length >= 1 && j.campaigns[0].domain === 'adcb-secure-login.com');
  check('threats → الخصوصية: recent بلا URLs كاملة', j.recent.every(e => !e.url));
}
{
  const core = freshCore();
  const health = require('../api/health.js');
  const res = mockRes();
  await health(mockReq({}), res);
  const j = res.json();
  check('health → 200 وok', res.statusCode === 200 && j.ok === true);
  check('health → اسم الخدمة hisn-api', j.service === 'hisn-api');
  check('health → إصدار المحرك 2.2.0', j.version === '2.2.0');
  check('health → حالة الطبقة الذكية', typeof j.aiHook === 'boolean');
}

/* ============ 4) حد المعدل ============ */
{
  const core = freshCore();
  const scan = require('../api/scan.js');
  let limited = false;
  for (let i = 0; i < 122; i++) {
    const res = mockRes();
    await scan(mockReq({ query: { url: 'https://example.com' }, socketIp: '198.51.100.7' }), res);
    if (res.statusCode === 429) { limited = true; break; }
  }
  check('حد المعدل 120/دقيقة يعمل', limited);
  const other = mockRes();
  await scan(mockReq({ query: { url: 'https://example.com' }, socketIp: '198.51.100.8' }), other);
  check('حد المعدل لكل IP منفصل', other.statusCode === 200);
}

/* ============ 5) /api/shortcut — توليد ملفات الاختصارات ============ */
{
  const core = freshCore();
  const shortcut = require('../api/shortcut.js');
  const res = mockRes();
  await shortcut(mockReq({ query: { name: 'clip' }, headers: { host: 'hisn.example.vercel.app', 'x-forwarded-proto': 'https' } }), res);
  const xml = res.body();
  check('shortcut clip → 200', res.statusCode === 200);
  check('shortcut clip → محتوى ثنائي التحميل', res.headers['content-type'] === 'application/octet-stream');
  check('shortcut clip → اسم ملف عربي', res.headers['content-disposition'].indexOf('.shortcut') !== -1);
  check('shortcut clip → XML plist صالح البداية', xml.indexOf('<?xml version="1.0"') === 0);
  check('shortcut clip → DOCTYPE صحيح', xml.indexOf('PropertyList-1.0.dtd') !== -1);
  check('shortcut clip → إجراء الحافظة', xml.indexOf('is.workflow.actions.getclipboard') !== -1);
  check('shortcut clip → ترميز URL', xml.indexOf('is.workflow.actions.urlencode') !== -1);
  check('shortcut clip → جلب الرابط', xml.indexOf('is.workflow.actions.downloadurl') !== -1);
  check('shortcut clip → إظهار النتيجة', xml.indexOf('is.workflow.actions.showresult') !== -1);
  check('shortcut clip → عنوان الموقع محفور', xml.indexOf('https://hisn.example.vercel.app/api/scan') !== -1);
  check('shortcut clip → format=text للتنبيهات', xml.indexOf('format=text') !== -1);
  check('shortcut clip → حماية XML للعلامة &', xml.indexOf('&format') === -1);
}
{
  const core = freshCore();
  const shortcut = require('../api/shortcut.js');
  const res = mockRes();
  await shortcut(mockReq({ query: { name: 'share' }, headers: { host: 'hisn.example.vercel.app' } }), res);
  const xml = res.body();
  check('shortcut share → إجراء المشاركة', xml.indexOf('is.workflow.actions.geturlsfrominput') !== -1);
  check('shortcut share → نوع ShareSheet', xml.indexOf('ShareSheet') !== -1);
  check('shortcut share → مصدر shortcut في API', xml.indexOf('source=shortcut') !== -1);
}
{
  const core = freshCore();
  const shortcut = require('../api/shortcut.js');
  const res = mockRes();
  await shortcut(mockReq({ query: {}, headers: {} }), res);
  check('shortcut بلا ترويسة host → 400', res.statusCode === 400);
}
{
  const core = freshCore();
  const shortcut = require('../api/shortcut.js');
  const res = mockRes();
  /* ترويسة host عدوانية — تُرفض */
  await shortcut(mockReq({ query: {}, headers: { host: 'evil.com\r\nX-Injected: 1' } }), res);
  check('shortcut host مشوه → 400', res.statusCode === 400);
}

/* ============ 6) سلامة التوافق: بنية استجابة scan متطابقة مع واجهات الموقع ============ */
{
  const core = freshCore();
  const scan = require('../api/scan.js');
  const res = mockRes();
  await scan(mockReq({ query: { url: 'https://еmiratesnbd.com' } }), res);
  const j = res.json();
  check('scan homoglyph → comparison.substituted', Array.isArray(j.verdict.comparison.substituted) &&
    j.verdict.comparison.substituted.length > 0);
  check('scan homoglyph → diff يحصر الحرف', j.verdict.comparison.diff.fakeMid.length > 0);
}

/* ============ الخلاصة ============ */
console.log('\nدوال الخادم: ' + passed + ' نجح / ' + failed + ' فشل');
if (failed) {
  console.error('فشل ' + failed + ' اختباراً');
  process.exit(1);
}
})();
