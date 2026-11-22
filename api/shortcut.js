'use strict';
/*
 * حصن (Hisn) — دالة توليد اختصارات iOS جاهزة للاستيراد بنقرة واحدة
 * GET /api/shortcut?name=clip|share  →  ملف .shortcut (XML plist) يُستورد مباشرة في تطبيق «الاختصارات»
 *
 * لماذا هذه الدالة؟ كانت الملفات الثابتة القديمة public/shortcut/a1.shortcut و a2.shortcut
 * تالفة (binary plist مفسود يرفضه iOS) وأسماؤها لا تطابق روابط التثبيت في الموقع.
 * الحل: توليد الملف عند الطلب من عنوان النشر الفعلي (من ترويسات x-forwarded-host/host)
 * — فلا يحتاج المستخدم لصق أي عنوان: الاختصار المُستورد يستدعي /api/scan على نفس الموقع.
 *
 * ملاحظة صريحة: iOS يطلب تفعيل «السماح بالاختصارات غير الموثوقة» لاستيراد ملفات غير موقعة،
 * والموقع يشرح ذلك في بطاقة التثبيت (untrustNote).
 */
const core = require('./_lib/core.js');

/* حماية من أي رمز XML خاص في القيم الديناميكية (العنوان المولّد) */
function xmlEsc(s) {
  return String(s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&apos;');
}

/* إشارة متغير داخل نص الاختصار (WFTextTokenString) */
function tokenString(text, attachments) {
  return '<dict>' +
    '<key>Value</key><dict>' +
    '<key>attachments</key><array>' + attachments.join('') + '</array>' +
    '<key>string</key><string>' + xmlEsc(text) + '</string>' +
    '</dict>' +
    '<key>WFSerializationType</key><string>WFTextTokenString</string>' +
    '</dict>';
}

/* إشارة مرجعية لمخرَج إجراء سابق (WFTextTokenAttachment) */
function tokenAttachment(outputName, outputUuid) {
  return '<dict>' +
    '<key>Value</key><dict>' +
    '<key>OutputName</key><string>' + xmlEsc(outputName) + '</string>' +
    '<key>OutputUUID</key><string>' + xmlEsc(outputUuid) + '</string>' +
    '<key>Type</key><string>ActionOutput</string>' +
    '</dict>' +
    '<key>WFSerializationType</key><string>WFTextTokenAttachment</string>' +
    '</dict>';
}

function action(identifier, paramsXml) {
  return '<dict>' +
    '<key>WFWorkflowActionIdentifier</key><string>' + xmlEsc(identifier) + '</string>' +
    '<key>WFWorkflowActionParameters</key><dict>' + (paramsXml || '') + '</dict>' +
    '</dict>';
}

/*
 * بناء XML plist كامل لملف الاختصار.
 * variant = 'clip'  : الحصول على الحافظة ← ترميز URL ← جلب نتيجة الفحص النصية ← إظهار النتيجة
 * variant = 'share' : الحصول على روابط من إدخال المشاركة ← نفس السلسلة
 */
function buildShortcutXml(origin, variant) {
  const isClip = variant !== 'share';
  const apiBase = origin.replace(/\/+$/, '') +
    '/api/scan?source=' + (isClip ? 'clipboard' : 'shortcut') + '&format=text&url=';
  const firstAction = isClip
    ? action('is.workflow.actions.getclipboard', '<key>UUID</key><string>HISN-CLIP-1A2B</string>')
    : action('is.workflow.actions.geturlsfrominput', '<key>UUID</key><string>HISN-URL-1G2H</string>');
  const firstOutputRef = tokenAttachment(isClip ? 'Clipboard' : 'URL', isClip ? 'HISN-CLIP-1A2B' : 'HISN-URL-1G2H');

  return '<?xml version="1.0" encoding="UTF-8"?>' +
    '<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">' +
    '<plist version="1.0"><dict>' +
    '<key>WFWorkflowActions</key><array>' +
    firstAction +
    action('is.workflow.actions.urlencode',
      '<key>UUID</key><string>HISN-ENC-2C3D</string>' +
      '<key>WFEncodeMode</key><string>Encode</string>' +
      '<key>WFInput</key>' + firstOutputRef) +
    action('is.workflow.actions.downloadurl',
      '<key>UUID</key><string>HISN-API-3E4F</string>' +
      '<key>WFURL</key>' + tokenString(apiBase, [
        tokenAttachment('Encoded Text', 'HISN-ENC-2C3D')
      ])) +
    action('is.workflow.actions.showresult',
      '<key>WFInput</key>' + tokenAttachment('Contents of URL', 'HISN-API-3E4F')) +
    '</array>' +
    '<key>WFWorkflowClientVersion</key><string>1146.14</string>' +
    '<key>WFWorkflowHasOutputFallback</key><false/>' +
    '<key>WFWorkflowHasShortcutInputVariables</key>' + (isClip ? '<false/>' : '<true/>') +
    '<key>WFWorkflowIcon</key><dict>' +
    '<key>WFWorkflowIconGlyphNumber</key><integer>59769</integer>' +
    '<key>WFWorkflowIconStartColor</key><integer>4282601983</integer>' +
    '</dict>' +
    '<key>WFWorkflowImportQuestions</key><array/>' +
    '<key>WFWorkflowInputContentItemClasses</key><array>' +
    '<string>WFURLContentItem</string>' +
    '<string>WFStringContentItem</string>' +
    '<string>WFSafariWebsiteContentItem</string>' +
    '</array>' +
    '<key>WFWorkflowMinimumClientVersion</key><integer>900</integer>' +
    '<key>WFWorkflowMinimumClientVersionString</key><string>900</string>' +
    '<key>WFWorkflowTypes</key><array>' +
    (isClip ? '<string>WatchKit</string>' : '<string>ShareSheet</string><string>WatchKit</string>') +
    '</array>' +
    '</dict></plist>';
}

module.exports = async (req, res) => {
  if (req.method === 'OPTIONS') return core.preflight(res);
  const ip = (req.socket && req.socket.remoteAddress) || 'unknown';
  if (!core.rateOk(ip)) return core.send(res, 429, { ok: false, error: 'rate limit exceeded' });

  /* عنوان النشر الفعلي من ترويسات Vercel — يُحفر داخل الاختصار ليستدعي /api/scan على نفس الموقع */
  const proto = String((req.headers && req.headers['x-forwarded-proto']) || 'https').split(',')[0].trim();
  const host = String((req.headers && req.headers['x-forwarded-host']) || (req.headers && req.headers.host) || '').split(',')[0].trim();
  if (!host || !/^[a-z0-9.\-:\[\]]+$/i.test(host)) {
    return core.send(res, 400, { ok: false, error: 'invalid host header' });
  }
  const origin = proto + '://' + host;

  const variant = ((req.query && req.query.name) === 'share') ? 'share' : 'clip';
  const fileName = variant === 'share' ? 'حصن-فحص-المشاركة.shortcut' : 'حصن-فحص-الحافظة.shortcut';
  const xml = buildShortcutXml(origin, variant);

  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Content-Type', 'application/octet-stream');
  /* RFC 5987: اسم الملف يحتوي أحرفاً عربية */
  res.setHeader('Content-Disposition', "attachment; filename*=UTF-8''" + encodeURIComponent(fileName));
  res.setHeader('Cache-Control', 'no-store');
  res.statusCode = 200;
  res.end(xml);
};
