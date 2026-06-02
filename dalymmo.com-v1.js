// ==UserScript==
// @name         ThienThaiTruyen Infinite Reader Ultra
// @namespace    local
// @version      3.3.0
// @description  Tự động nối chương tiếp theo, hỗ trợ menu mobile, nhiều tên miền
// @include      /^https?:\/\/(?:www\.)?thienthaitruyen\d*\.[a-z.]+\/.*\/chuong-\d+(?:\.html)?\/?$/
// @grant        none
// @run-at       document-idle
// ==/UserScript==

(() => {
  'use strict';

  if (!/^(www\.)?thienthaitruyen\d*\./i.test(location.hostname)) return;
  if (!/\/chuong-\d+(?:\.html)?\/?$/i.test(location.pathname)) return;

  const CONFIG_KEY = 'ttt_ir_ultra_config_v31';
  const DEFAULT_CONFIG = {
    enabled: true,
    updateUrl: true,
    removeAds: true,
    prefetchAhead: 1,
    triggerDistance: 2400,
    retryCount: 2,
    retryDelay: 650,
  };

  const config = loadConfig();
  const state = {
    currentUrl: cleanUrl(location.href),
    loadedUrls: new Set([cleanUrl(location.href)]),
    appendedUrls: new Set(),
    cache: new Map(),
    inFlight: new Map(),
    busy: false,
    ended: false,
    maxChapter: detectMaxChapter(document),
    root: null,
    sentinel: null,
    autoLocked: false,
    lastAppendScrollY: 0,
  };

  const ui = createUI();
  init();

  function init() {
    installStyles();
    state.root = findReaderRoot(document) || document.body;
    setupObserver();
    setupScrollFallback();
    hydrateInitialImages();
    toast(config.enabled ? 'Tự động nối chương: ON.' : 'Tự động nối chương: OFF.');
    prefetchUpcoming();
  }

  function loadConfig() {
    try {
      return { ...DEFAULT_CONFIG, ...JSON.parse(localStorage.getItem(CONFIG_KEY) || '{}') };
    } catch {
      return { ...DEFAULT_CONFIG };
    }
  }

  function saveConfig() {
    localStorage.setItem(CONFIG_KEY, JSON.stringify(config));
  }

  function cleanUrl(url) {
    return String(url).replace(/[?#].*$/, '').replace(/\/$/, '');
  }

  function chapterNo(url) {
    return Number(cleanUrl(url).match(/\/chuong-(\d+)(?:\.html)?$/i)?.[1] || 0);
  }

  function nextUrl(url, offset = 1) {
    const no = chapterNo(url);
    if (!no) return null;

    return cleanUrl(url).replace(/\/chuong-\d+(?:\.html)?$/i, matched => {
      const suffix = matched.toLowerCase().endsWith('.html') ? '.html' : '';
      return `/chuong-${no + offset}${suffix}`;
    });
  }

  function detectMaxChapter(doc) {
    const nums = [...doc.querySelectorAll('select.chapter-choose option[value*="/chuong-"]')]
      .map(option => chapterNo(option.value))
      .filter(Boolean);

    return nums.length ? Math.max(...nums) : Infinity;
  }

  function getComicImages(scope) {
    return [...scope.querySelectorAll('img')].filter(img => {
      const src = img.currentSrc || img.src || img.getAttribute('src') || '';
      return /\/chuong-\d+\//i.test(src) && !/banner|logo|thumb|default|loading/i.test(src);
    });
  }

  function findReaderRoot(doc) {
    const images = getComicImages(doc);
    if (!images.length) return null;

    let bestNode = null;
    let bestScore = 0;

    for (const image of images) {
      let node = image.parentElement;
      while (node && node !== doc.body && node.nodeType === 1) {
        const comicCount = getComicImages(node).length;
        const allImages = node.querySelectorAll?.('img').length || 0;
        const score = comicCount * 10 - Math.max(0, allImages - comicCount);

        if (score > bestScore) {
          bestScore = score;
          bestNode = node;
        }

        node = node.parentElement;
      }
    }

    return bestNode || images[0].parentElement || doc.body;
  }

  function getChapterBlocks(doc, no) {
    const images = getComicImages(doc).filter(img => {
      const src = img.src || img.getAttribute('src') || '';
      return src.includes(`/chuong-${no}/`);
    });

    return [...new Set(images.map(img => img.closest('.center') || img.parentElement || img))];
  }

  async function prefetchUpcoming() {
    prunePrefetchCache();
    if (!config.enabled || state.ended) return;

    for (let offset = 1; offset <= config.prefetchAhead; offset++) {
      const url = nextUrl(state.currentUrl, offset);
      if (!shouldFetch(url)) continue;
      fetchChapter(url).catch(() => {});
    }
  }

  function prunePrefetchCache() {
    const currentNo = chapterNo(state.currentUrl);
    const maxNo = currentNo + config.prefetchAhead;

    for (const [url] of state.cache) {
      const no = chapterNo(url);
      if (no <= currentNo || no > maxNo) state.cache.delete(url);
    }
  }

  function shouldFetch(url) {
    return Boolean(
      url &&
      chapterNo(url) <= state.maxChapter &&
      !state.loadedUrls.has(url) &&
      !state.cache.has(url) &&
      !state.inFlight.has(url)
    );
  }

  async function fetchChapter(url) {
    url = cleanUrl(url);
    if (state.cache.has(url)) return state.cache.get(url);
    if (state.inFlight.has(url)) return state.inFlight.get(url);

    const promise = retry(async () => {
      const res = await fetch(url, {
        credentials: 'include',
        headers: { accept: 'text/html,application/xhtml+xml' },
      });

      if (!res.ok) throw new Error(`HTTP ${res.status}`);

      const html = await res.text();
      const doc = new DOMParser().parseFromString(html, 'text/html');
      const no = chapterNo(url);
      const blocks = getChapterBlocks(doc, no);

      if (!blocks.length) throw new Error('Không tìm thấy ảnh chương.');

      const data = { url, no, title: doc.title || `Chương ${no}`, blocks };
      const currentNo = chapterNo(state.currentUrl);
      if (no <= currentNo + config.prefetchAhead) state.cache.set(url, data);
      return data;
    }, config.retryCount, config.retryDelay);

    state.inFlight.set(url, promise);

    try {
      return await promise;
    } finally {
      state.inFlight.delete(url);
    }
  }

  async function retry(task, count, delay) {
    let lastError;

    for (let attempt = 0; attempt <= count; attempt++) {
      try {
        return await task();
      } catch (error) {
        lastError = error;
        if (attempt < count) await sleep(delay * (attempt + 1));
      }
    }

    throw lastError;
  }

  function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  async function appendNextChapter(manual = false) {
    if (!config.enabled || state.busy || state.ended) return;
    if (!manual && state.autoLocked) return;

    const url = nextUrl(state.currentUrl);
    const no = chapterNo(url || '');

    if (!url || state.loadedUrls.has(url) || state.appendedUrls.has(url)) return;

    if (no > state.maxChapter) {
      state.ended = true;
      toast('Đã tới chương mới nhất.');
      return;
    }

    state.busy = true;
    setBusy(true, `Đang tải chương ${no}...`);

    try {
      const data = await fetchChapter(url);
      renderChapter(data);

      state.currentUrl = url;
      state.loadedUrls.add(url);
      state.appendedUrls.add(url);

      if (config.updateUrl) history.replaceState(null, '', url);

      setBusy(false, `Đã nối chương ${no}.`);
      state.autoLocked = !manual;
      state.lastAppendScrollY = scrollY;
      moveSentinelToReaderEnd();
      prefetchUpcoming();
    } catch (error) {
      if (/HTTP 404|Không tìm thấy ảnh chương/i.test(error.message)) state.ended = true;
      setBusy(false, `Lỗi tải chương ${no}: ${error.message}`);
    } finally {
      state.busy = false;
    }
  }

  function renderChapter(data) {
    const fragment = document.createDocumentFragment();
    fragment.appendChild(createDivider(data.no));

    for (const block of data.blocks) {
      const clone = block.cloneNode(true);
      sanitizeNode(clone);
      fragment.appendChild(clone);
    }

    if (state.sentinel?.parentElement === state.root) state.sentinel.remove();
    state.root.appendChild(fragment);
  }

  function sanitizeNode(node) {
    node.querySelectorAll?.('[id]').forEach(el => el.removeAttribute('id'));

    if (config.removeAds) {
      node.querySelectorAll?.('script, iframe, ins, [data-cl-spot], [data-zone], [data-id], .ads, .ad, .advertisement, .banner')
        .forEach(el => el.remove());
    }

    node.querySelectorAll?.('img').forEach(img => {
      img.loading = 'lazy';
      img.decoding = 'async';
      img.removeAttribute('fetchpriority');
      img.style.maxWidth = '100%';
      img.style.height = 'auto';
    });
  }

  function hydrateInitialImages() {
    document.querySelectorAll('img').forEach(img => {
      img.decoding = 'async';
      if (!isInViewport(img)) img.loading = 'lazy';
    });
  }

  function isInViewport(el) {
    const rect = el.getBoundingClientRect();
    return rect.top < innerHeight && rect.bottom > 0;
  }

  function createDivider(no) {
    const div = document.createElement('div');
    div.className = 'ttt-ir-divider';
    div.innerHTML = `<span>Chương ${no}</span>`;
    return div;
  }

  function setupObserver() {
    const sentinel = document.createElement('div');
    sentinel.id = 'ttt-ir-sentinel';
    state.sentinel = sentinel;
    moveSentinelToReaderEnd();

    const observer = new IntersectionObserver(entries => {
      if (entries.some(entry => entry.isIntersecting)) appendNextChapter(false);
    }, { rootMargin: `${config.triggerDistance}px 0px` });

    observer.observe(sentinel);
  }

  function moveSentinelToReaderEnd() {
    if (!state.sentinel || !state.root) return;
    state.root.appendChild(state.sentinel);
  }

  function setupScrollFallback() {
    let ticking = false;

    window.addEventListener('scroll', () => {
      if (ticking) return;
      ticking = true;

      requestAnimationFrame(() => {
        ticking = false;
        const pageHeight = Math.max(document.body.scrollHeight, document.documentElement.scrollHeight);
        const readerBottom = getReaderBottom();
        const nearReaderEnd = innerHeight + scrollY > readerBottom - config.triggerDistance;
        if (state.autoLocked && scrollY > state.lastAppendScrollY + 480) state.autoLocked = false;
        updateProgress(pageHeight);
        if (nearReaderEnd) appendNextChapter(false);
      });
    }, { passive: true });
  }

  function getReaderBottom() {
    const rect = state.root?.getBoundingClientRect?.();
    return rect ? rect.bottom + scrollY : document.documentElement.scrollHeight;
  }

  function updateProgress(pageHeight) {
    const max = Math.max(1, pageHeight - innerHeight);
    const percent = Math.min(100, Math.max(0, (scrollY / max) * 100));
    ui.progress.style.width = `${percent}%`;
  }

  function createUI() {
    const dock = document.createElement('div');
    dock.id = 'ttt-ir-dock';

    const fab = document.createElement('button');
    fab.id = 'ttt-ir-fab';
    fab.type = 'button';
    fab.innerHTML = '<span>∞</span>';
    fab.setAttribute('aria-label', 'Mở menu Infinite Reader');

    const sheet = document.createElement('div');
    sheet.id = 'ttt-ir-sheet';

    const grabber = document.createElement('div');
    grabber.id = 'ttt-ir-grabber';

    const header = document.createElement('div');
    header.id = 'ttt-ir-header';

    const title = document.createElement('div');
    title.id = 'ttt-ir-title';
    title.textContent = 'Infinite Reader';

    const close = makeButton('Đóng', 'ttt-ir-close');
    close.onclick = () => setOpen(false);

    const message = document.createElement('div');
    message.id = 'ttt-ir-message';

    const actions = document.createElement('div');
    actions.id = 'ttt-ir-actions';

    const toggle = makeButton('', 'ttt-ir-toggle');
    toggle.onclick = toggleEnabled;

    const next = makeButton('Tải chương tiếp', 'ttt-ir-next');
    next.onclick = () => appendNextChapter(true);

    const prefetch = makeButton('', 'ttt-ir-prefetch');
    prefetch.onclick = () => {
      config.prefetchAhead = config.prefetchAhead >= 6 ? 1 : config.prefetchAhead + 1;
      prunePrefetchCache();
      saveConfig();
      syncUI();
      toast(`Tải trước ${config.prefetchAhead} chương.`);
      prefetchUpcoming();
    };

    const updateUrl = makeButton('', 'ttt-ir-url');
    updateUrl.onclick = () => {
      config.updateUrl = !config.updateUrl;
      saveConfig();
      syncUI();
      toast(`Đổi URL: ${config.updateUrl ? 'ON' : 'OFF'}.`);
    };

    const ads = makeButton('', 'ttt-ir-ads');
    ads.onclick = () => {
      config.removeAds = !config.removeAds;
      saveConfig();
      syncUI();
      toast(`Lọc quảng cáo: ${config.removeAds ? 'ON' : 'OFF'}.`);
    };

    const top = makeButton('Lên đầu', 'ttt-ir-top-btn');
    top.onclick = () => scrollTo({ top: 0, behavior: 'smooth' });

    const bottom = makeButton('Xuống cuối', 'ttt-ir-bottom-btn');
    bottom.onclick = () => scrollTo({ top: document.documentElement.scrollHeight, behavior: 'smooth' });

    const settings = document.createElement('div');
    settings.id = 'ttt-ir-settings';

    const prefetchSetting = makeRangeSetting({
      id: 'ttt-ir-prefetch-range',
      label: 'Tải trước chương',
      min: 1,
      max: 6,
      step: 1,
      value: config.prefetchAhead,
      suffix: 'chương',
      onChange: value => {
        config.prefetchAhead = value;
        prunePrefetchCache();
        saveConfig();
        syncUI();
        prefetchUpcoming();
      },
    });

    const distanceSetting = makeRangeSetting({
      id: 'ttt-ir-distance-range',
      label: 'Gần cuối thì tải',
      min: 600,
      max: 6000,
      step: 300,
      value: config.triggerDistance,
      suffix: 'px',
      onChange: value => {
        config.triggerDistance = value;
        saveConfig();
        syncUI();
      },
    });

    settings.append(prefetchSetting.wrap, distanceSetting.wrap);

    const progress = document.createElement('div');
    progress.id = 'ttt-ir-progress';

    const progressBar = document.createElement('div');
    progressBar.id = 'ttt-ir-progress-bar';

    fab.onclick = event => {
      event.stopPropagation();
      setOpen(!dock.classList.contains('open'));
    };
    sheet.addEventListener('click', event => event.stopPropagation());
    document.addEventListener('pointerdown', event => {
      if (dock.classList.contains('open') && !dock.contains(event.target)) setOpen(false);
    }, { passive: true });

    header.append(title, close);
    actions.append(toggle, next, prefetch, updateUrl, ads, top, bottom);
    progress.append(progressBar);
    sheet.append(grabber, header, message, actions, settings, progress);
    dock.append(fab, sheet);
    document.body.appendChild(dock);

    const refs = {
      dock,
      fab,
      sheet,
      toggle,
      prefetch,
      updateUrl,
      ads,
      message,
      progress: progressBar,
      prefetchValue: prefetchSetting.value,
      prefetchRange: prefetchSetting.input,
      distanceValue: distanceSetting.value,
      distanceRange: distanceSetting.input,
    };
    syncUI(refs);
    return refs;
  }

  function makeRangeSetting({ id, label, min, max, step, value, suffix, onChange }) {
    const wrap = document.createElement('label');
    wrap.className = 'ttt-ir-setting';
    wrap.htmlFor = id;

    const top = document.createElement('div');
    top.className = 'ttt-ir-setting-top';

    const name = document.createElement('span');
    name.textContent = label;

    const valueEl = document.createElement('b');
    valueEl.textContent = `${value} ${suffix}`;

    const input = document.createElement('input');
    input.id = id;
    input.type = 'range';
    input.min = String(min);
    input.max = String(max);
    input.step = String(step);
    input.value = String(value);

    input.addEventListener('input', () => {
      const nextValue = Number(input.value);
      valueEl.textContent = `${nextValue} ${suffix}`;
      onChange(nextValue);
    });

    top.append(name, valueEl);
    wrap.append(top, input);
    return { wrap, input, value: valueEl };
  }

  function makeButton(text, id) {
    const button = document.createElement('button');
    button.type = 'button';
    button.id = id;
    button.textContent = text;
    return button;
  }

  function setOpen(open) {
    ui.dock.classList.toggle('open', open);
  }

  function toggleEnabled() {
    config.enabled = !config.enabled;
    saveConfig();
    syncUI();
    toast(config.enabled ? 'Tự động nối chương: ON.' : 'Tự động nối chương: OFF.');
    if (config.enabled) prefetchUpcoming();
  }

  function syncUI(refs = ui) {
    refs.toggle.textContent = `Tự động: ${config.enabled ? 'ON' : 'OFF'}`;
    refs.prefetch.textContent = `Tải trước: ${config.prefetchAhead}`;
    refs.updateUrl.textContent = `Đổi URL: ${config.updateUrl ? 'ON' : 'OFF'}`;
    refs.ads.textContent = `Lọc ads: ${config.removeAds ? 'ON' : 'OFF'}`;
    refs.prefetchValue.textContent = `${config.prefetchAhead} chương`;
    refs.prefetchRange.value = String(config.prefetchAhead);
    refs.distanceValue.textContent = `${config.triggerDistance} px`;
    refs.distanceRange.value = String(config.triggerDistance);
    refs.fab.classList.toggle('on', config.enabled);
    refs.toggle.classList.toggle('on', config.enabled);
  }

  function setBusy(isBusy, text) {
    ui.dock.classList.toggle('busy', isBusy);
    toast(text);
  }

  function toast(text) {
    ui.message.textContent = text;
    ui.dock.classList.add('show');

    clearTimeout(toast.timer);
    toast.timer = setTimeout(() => {
      if (!state.busy) ui.dock.classList.remove('show');
    }, 2800);
  }

  function installStyles() {
    const style = document.createElement('style');
    style.textContent = `
      #ttt-ir-dock {
        position: fixed;
        right: 18px;
        bottom: 96px;
        z-index: 2147483647;
        font-family: Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
      }

      #ttt-ir-fab {
        width: 32px;
        height: 32px;
        display: grid;
        place-items: center;
        border: 1px solid rgba(255,255,255,.18);
        border-radius: 999px;
        color: #fff;
        background: linear-gradient(135deg, #ef4444, #7f1d1d);
        font-size: 20px;
        font-weight: 900;
        line-height: 1;
        box-shadow: 0 10px 26px rgba(0,0,0,.38);
        cursor: pointer;
        opacity: .9;
      }

      #ttt-ir-fab span {
        transform: translateY(-1px);
      }

      #ttt-ir-fab.on {
        background: linear-gradient(135deg, #ef4444, #f97316);
        box-shadow: 0 10px 26px rgba(239,68,68,.38);
      }

      #ttt-ir-sheet {
        position: absolute;
        right: 0;
        bottom: 44px;
        width: min(340px, calc(100vw - 28px));
        overflow: hidden;
        border: 1px solid rgba(255,255,255,.14);
        border-radius: 22px;
        color: #fff;
        background:
          radial-gradient(circle at top left, rgba(239,68,68,.36), transparent 36%),
          linear-gradient(145deg, rgba(20,20,24,.94), rgba(8,8,10,.92));
        backdrop-filter: blur(18px);
        box-shadow: 0 22px 65px rgba(0,0,0,.52), inset 0 1px 0 rgba(255,255,255,.08);
        transform: translateY(12px) scale(.96);
        transform-origin: bottom right;
        opacity: 0;
        pointer-events: none;
        transition: .18s ease;
      }

      #ttt-ir-dock.open #ttt-ir-sheet {
        transform: translateY(0) scale(1);
        opacity: 1;
        pointer-events: auto;
      }

      #ttt-ir-grabber {
        width: 44px;
        height: 4px;
        margin: 10px auto 4px;
        border-radius: 999px;
        background: rgba(255,255,255,.25);
      }

      #ttt-ir-header {
        display: flex;
        align-items: center;
        justify-content: space-between;
        gap: 10px;
        padding: 8px 13px;
      }

      #ttt-ir-title {
        font-size: 14px;
        font-weight: 900;
        letter-spacing: .2px;
      }

      #ttt-ir-close {
        width: auto !important;
        padding: 7px 10px !important;
      }

      #ttt-ir-message {
        min-height: 20px;
        padding: 0 13px 11px;
        color: rgba(255,255,255,.78);
        font-size: 12px;
        line-height: 1.45;
      }

      #ttt-ir-actions {
        display: grid;
        grid-template-columns: 1fr 1fr;
        gap: 8px;
        padding: 0 11px 12px;
      }

      #ttt-ir-actions button,
      #ttt-ir-close {
        border: 1px solid rgba(255,255,255,.12);
        border-radius: 13px;
        padding: 10px 8px;
        color: rgba(255,255,255,.9);
        background: rgba(255,255,255,.075);
        font-size: 12px;
        font-weight: 800;
        cursor: pointer;
        touch-action: manipulation;
      }

      #ttt-ir-actions button:active,
      #ttt-ir-close:active,
      #ttt-ir-fab:active {
        transform: scale(.97);
      }

      #ttt-ir-toggle.on {
        background: linear-gradient(135deg, rgba(239,68,68,.85), rgba(249,115,22,.85));
      }

      #ttt-ir-next {
        grid-column: span 2;
        background: linear-gradient(135deg, rgba(239,68,68,.85), rgba(249,115,22,.85)) !important;
      }

      #ttt-ir-settings {
        display: grid;
        gap: 10px;
        padding: 0 12px 13px;
      }

      .ttt-ir-setting {
        display: grid;
        gap: 8px;
        padding: 10px;
        border: 1px solid rgba(255,255,255,.1);
        border-radius: 14px;
        background: rgba(255,255,255,.055);
      }

      .ttt-ir-setting-top {
        display: flex;
        align-items: center;
        justify-content: space-between;
        gap: 10px;
        color: rgba(255,255,255,.86);
        font-size: 12px;
        font-weight: 750;
      }

      .ttt-ir-setting-top b {
        color: #fed7aa;
        font-size: 12px;
      }

      .ttt-ir-setting input[type="range"] {
        width: 100%;
        accent-color: #f97316;
      }

      #ttt-ir-progress {
        height: 3px;
        background: rgba(255,255,255,.09);
      }

      #ttt-ir-progress-bar {
        width: 0%;
        height: 100%;
        background: linear-gradient(90deg, #ef4444, #f97316, #facc15);
        transition: width .12s linear;
      }

      .ttt-ir-divider {
        position: relative;
        margin: 44px auto 24px;
        max-width: 920px;
        padding: 0 16px;
        text-align: center;
      }

      .ttt-ir-divider::before {
        content: "";
        position: absolute;
        left: 16px;
        right: 16px;
        top: 50%;
        height: 1px;
        background: linear-gradient(90deg, transparent, rgba(255,255,255,.24), transparent);
      }

      .ttt-ir-divider span {
        position: relative;
        display: inline-flex;
        align-items: center;
        justify-content: center;
        min-width: 150px;
        padding: 12px 22px;
        border: 1px solid rgba(255,255,255,.15);
        border-radius: 999px;
        color: #fff;
        background: radial-gradient(circle at top left, rgba(239,68,68,.45), transparent 40%), linear-gradient(135deg, #1f1f23, #09090b);
        font-size: 20px;
        font-weight: 900;
        box-shadow: 0 12px 34px rgba(0,0,0,.32);
      }

      #ttt-ir-sentinel { height: 1px; }

      @media (max-width: 560px) {
        #ttt-ir-dock {
          right: 12px;
          bottom: max(94px, calc(94px + env(safe-area-inset-bottom)));
        }

        #ttt-ir-sheet {
          position: fixed;
          left: 10px;
          right: 10px;
          bottom: max(136px, calc(136px + env(safe-area-inset-bottom)));
          width: auto;
          transform-origin: bottom center;
        }

        #ttt-ir-fab {
          width: 32px;
          height: 32px;
          font-size: 20px;
        }
      }
    `;
    document.head.appendChild(style);
  }
})();







