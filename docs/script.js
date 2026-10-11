/* AI 翻译助手 · 宣传站点 —— 极少量交互脚本 */
(function () {
  'use strict';

  var topbar = document.querySelector('[data-topbar]');
  var toggle = document.querySelector('[data-nav-toggle]');
  var nav = document.querySelector('[data-nav]');

  /* 顶栏：滚动后浮出底色 */
  if (topbar) {
    var onScroll = function () {
      topbar.classList.toggle('is-stuck', window.scrollY > 24);
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
      if (e.key === 'Escape') setOpen(false);
    });

    window.addEventListener('resize', function () {
      if (window.innerWidth > 800) setOpen(false);
    });
  }

  /* 整页翻译示意：切换「替换原文 / 双语对照」 */
  Array.prototype.forEach.call(document.querySelectorAll('[data-demo="page"]'), function (demo) {
    var buttons = demo.querySelectorAll('.seg [data-mode]');

    Array.prototype.forEach.call(buttons, function (btn) {
      btn.addEventListener('click', function () {
        var replace = btn.getAttribute('data-mode') === 'replace';
        demo.classList.toggle('is-replace', replace);
        Array.prototype.forEach.call(buttons, function (b) {
          var on = b === btn;
          b.classList.toggle('chip--on', on);
          b.setAttribute('aria-pressed', String(on));
        });
      });
    });
  });
})();
