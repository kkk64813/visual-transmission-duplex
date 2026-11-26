/* 共用外殼邏輯：語系（繁中／EN）、說明書彈窗、頁腳版本戳。
 * 用法：頁面先引入 ui.js，然後
 *   UI.add({ 'key': ['繁中', 'English'] })      // 本頁字典
 *   <span data-i18n="key">繁中</span>           // 會被自動替換
 *   .u-topbtn[data-open="彈窗id"]               // 點開彈窗
 *   .u-modal.u-hide[id]                        // 彈窗本體，內容標 data-i18n
 *   UI.apply()                                 // 頁尾呼叫一次 */
window.UI = (function () {
  var VER = 'v2026-11-26k', T = '2026-11-26 15:33';
  var KEY = 'vt-lang';
  var D = {};
  var cur = 'zh';

  function add(o) { for (var k in o) if (o.hasOwnProperty(k)) D[k] = o[k]; }

  function apply(lang) {
    if (lang) cur = lang;
    document.querySelectorAll('[data-i18n]').forEach(function (e) {
      var k = e.getAttribute('data-i18n'), v = D[k];
      if (v) e.textContent = v[cur === 'en' ? 1 : 0];
    });
    document.querySelectorAll('[data-i18n-ph]').forEach(function (e) {
      var k = e.getAttribute('data-i18n-ph'), v = D[k];
      if (v) e.setAttribute('placeholder', v[cur === 'en' ? 1 : 0]);
    });
    document.querySelectorAll('[data-i18n-title]').forEach(function (e) {
      var k = e.getAttribute('data-i18n-title'), v = D[k];
      if (v) e.setAttribute('title', v[cur === 'en' ? 1 : 0]);
    });
    document.querySelectorAll('.u-lang').forEach(function (e) { e.textContent = cur === 'en' ? '中' : 'EN'; });
    document.documentElement.lang = cur === 'en' ? 'en' : 'zh-Hant';
    try { localStorage.setItem(KEY, cur); } catch (e) { }
    try { window.dispatchEvent(new CustomEvent('ui-lang', { detail: cur })); } catch (e) { }
  }

  function toggle() { apply(cur === 'zh' ? 'en' : 'zh'); }
  function open(id) {
    var m = document.getElementById(id);
    if (!m) return;
    m.classList.remove('u-hide');
    try { window.dispatchEvent(new CustomEvent('ui-open', { detail: id })); } catch (e) { }
  }
  function close(id) {
    var m = document.getElementById(id);
    if (m) m.classList.add('u-hide');
  }

  function stamp() {
    var el = document.getElementById('verStamp');
    if (el) el.textContent = VER + ' · 更新 ' + T;
  }

  document.addEventListener('click', function (e) {
    var t = e.target;
    if (t && t.classList && t.classList.contains('u-modal')) { close(t.id); return; }
    var b = t && t.closest ? t.closest('[data-open]') : null;
    if (b) { open(b.getAttribute('data-open')); return; }
    var x = t && t.closest ? t.closest('[data-close]') : null;
    if (x) close(x.getAttribute('data-close'));
  });

  function boot() {
    var saved = 'zh';
    try { saved = localStorage.getItem(KEY) || 'zh'; } catch (e) { }
    apply(saved);
    stamp();
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
  else boot();

  return {
    ver: VER, time: T,
    add: add, apply: apply, toggle: toggle, open: open, close: close,
    lang: function () { return cur; },
    t: function (k) { var v = D[k]; return v ? v[cur === 'en' ? 1 : 0] : k; }
  };
})();
