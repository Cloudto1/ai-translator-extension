/* AI 翻译助手 · 宣传站点 —— 极少量交互脚本 */
(function () {
  'use strict';

  var each = function (list, fn) { Array.prototype.forEach.call(list, fn); };

  var topbar = document.querySelector('[data-topbar]');
  var toggle = document.querySelector('[data-nav-toggle]');
  var nav = document.querySelector('[data-nav]');

  /* 顶栏：滚动后显示分隔线 */
  if (topbar) {
    var onScroll = function () {
      topbar.classList.toggle('is-stuck', window.scrollY > 8);
    };
    onScroll();
    window.addEventListener('scroll', onScroll, { passive: true });
  }

  /* 移动端导航开合 */
  if (toggle && nav) {
    var setOpen = function (open) {
      nav.classList.toggle('is-open', open);
      toggle.setAttribute('aria-expanded', String(open));
      toggle.setAttribute('aria-label', open ? '关闭导航菜单' : '打开导航菜单');
    };

    toggle.addEventListener('click', function () {
      setOpen(!nav.classList.contains('is-open'));
    });

    nav.addEventListener('click', function (e) {
      if (e.target instanceof HTMLAnchorElement) setOpen(false);
    });

    document.addEventListener('keydown', function (e) {
      if (e.key === 'Escape' && nav.classList.contains('is-open')) {
        setOpen(false);
        toggle.focus();
      }
    });

    window.addEventListener('resize', function () {
      if (window.innerWidth > 800) setOpen(false);
    });
  }

  /* 阅读器演示：原文 / 双语对照 / 仅译文 */
  each(document.querySelectorAll('[data-demo="page"]'), function (demo) {
    var buttons = demo.querySelectorAll('[data-mode]');
    each(buttons, function (btn) {
      btn.addEventListener('click', function () {
        demo.setAttribute('data-view', btn.getAttribute('data-mode'));
        each(buttons, function (b) {
          b.setAttribute('aria-pressed', String(b === btn));
        });
      });
    });
  });

  /* 复制克隆命令：优先 Clipboard API，不可用（http / 旧浏览器）时回退 execCommand */
  var status = document.querySelector('[data-copy-status]');
  var idleStatus = status ? status.textContent : '';

  var copyText = function (text) {
    if (navigator.clipboard && window.isSecureContext) {
      return navigator.clipboard.writeText(text);
    }
    return new Promise(function (resolve, reject) {
      var ta = document.createElement('textarea');
      ta.value = text;
      ta.setAttribute('readonly', '');
      ta.style.cssText = 'position:fixed;top:0;left:0;opacity:0;pointer-events:none';
      document.body.appendChild(ta);
      ta.select();
      var ok = false;
      try { ok = document.execCommand('copy'); } catch (err) { ok = false; }
      document.body.removeChild(ta);
      ok ? resolve() : reject(new Error('copy failed'));
    });
  };

  each(document.querySelectorAll('[data-copy]'), function (btn) {
    var label = btn.querySelector('[data-copy-label]');
    var idleLabel = label ? label.textContent : '';
    var timer = 0;

    var reset = function () {
      btn.classList.remove('is-done');
      if (label) label.textContent = idleLabel;
      if (status) {
        status.textContent = idleStatus;
        status.classList.remove('is-err');
      }
    };

    btn.addEventListener('click', function () {
      var source = document.querySelector(btn.getAttribute('data-copy'));
      if (!source) return;
      window.clearTimeout(timer);
      copyText(source.textContent.trim()).then(function () {
        btn.classList.add('is-done');
        if (label) label.textContent = '已复制';
        if (status) { status.classList.remove('is-err'); status.textContent = '已复制到剪贴板，粘贴到终端运行即可。'; }
      }, function () {
        if (status) { status.classList.add('is-err'); status.textContent = '复制失败，请手动选中命令复制。'; }
      }).then(function () {
        timer = window.setTimeout(reset, 2200);
      });
    });
  });
})();
