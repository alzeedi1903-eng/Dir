/* درع السياق الاستباقي — منطق صفحة الحجب */
'use strict';

const $ = id => document.getElementById(id);

function send(msg) {
  return new Promise(resolve => {
    chrome.runtime.sendMessage(msg, r => { void chrome.runtime.lastError; resolve(r); });
  });
}

function escapeHtml(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

const params = new URLSearchParams(location.search);
const target = params.get('t') || '';

$('targetUrl').textContent = target || 'غير معروف';

if (target) {
  send({ type: 'analyze', url: target }).then(res => {
    if (!res) return;
    $('scoreChip').textContent = 'درجة الخطورة: ' + res.score + '/100';
    $('levelChip').textContent = 'التصنيف: ' + res.levelText;
    const list = $('reasons');
    list.innerHTML = '';
    res.reasons.forEach(r => {
      const li = document.createElement('li');
      li.textContent = r.text + (r.weight > 0 ? ' (+' + r.weight + ')' : '');
      list.appendChild(li);
    });
  });
}

$('backBtn').addEventListener('click', () => {
  // العودة للصفحة السابقة (نتيجة البحث أو الخريطة) إن وُجدت، وإلا صفحة جديدة فارغة
  if (history.length > 1) history.back();
  else window.location.href = 'about:blank';
});

$('reportBtn').addEventListener('click', async () => {
  const res = await send({ type: 'analyze', url: target }).catch(() => null);
  await send({
    type: 'report',
    url: target,
    score: res ? res.score : null,
    level: res ? res.level : 'danger',
    note: 'مُبلّغ عنه من صفحة الحجب (احتيال مؤكد من المستخدم)',
    source: 'interstitial'
  });
  $('reportBtn').textContent = 'تم الإبلاغ ✓';
  setTimeout(() => { $('reportBtn').textContent = 'الإبلاغ كاحتيال مؤكد'; }, 2500);
});

$('continueBtn').addEventListener('click', async () => {
  await send({ type: 'allowOnce', url: target });
  try { location.replace(target); } catch (e) { location.href = target; }
});
