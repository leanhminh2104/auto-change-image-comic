// ==UserScript==
// @name         AutoChange Infinite Reader Universal
// @namespace    local
// @version      1.4.0
// @description  Auto nối chap đa web: chuong/chapter, số lẻ, next link/select, chống spam.
// @match        http://*/*
// @match        https://*/*
// @grant        none
// @run-at       document-idle
// ==/UserScript==

(() => {
  'use strict';

  const CHAPTER_RE = /(?:^|[\/-])(chuong|chapter)[-_]?(\d+(?:\.\d+)?)(?=$|[\/._-])/i;
  const BAD_HOST_RE = /google|facebook|youtube|tiktok|twitter|x\.com|discord|telegram/i;
  if (BAD_HOST_RE.test(location.hostname)) return;

  const CONFIG_KEY = 'autochange_ir_config_v2';
  const DEFAULT_CONFIG = {
    enabled: true,
    updateUrl: true,
    removeAds: true,
    debug: false,
    preferNextButton: true,
    prefetchAhead: 1,
    triggerDistance: 2200,
    retryCount: 2,
    retryDelay: 700,
    minImages: 1,
  };

  const initialUrl = cleanUrl(location.href);
  const initialChapter = parseChapter(initialUrl);
  if (!initialChapter) return;

  const config = loadConfig();
  const state = {
    currentUrl: initialUrl,
    loadedUrls: new Set([initialUrl]),
    requestedUrls: new Set(),
    missingUrls: new Set(),
    cache: new Map(),
    inFlight: new Map(),
    busy: false,
    ended: false,
    root: null,
    sentinel: null,
    autoLocked: false,
    lastAppendScrollY: 0,
    lastAutoAt: 0,
    chapterIndex: [],
    urlNo: new Map(),
  };

  state.chapterIndex = buildChapterIndex(document);
  const ui = createUI();
  init();

  function init() {
    installStyles();
    state.root = findReaderRoot(document) || document.body;
    hydrateInitialImages();
    setupObserver();
    setupScrollFallback();
    log('init', { current: parseChapter(state.currentUrl), indexed: state.chapterIndex.length, root: nodeLabel(state.root) });
    toast(`AutoChange ON • Chap ${chapterNo(state.currentUrl)} • index ${state.chapterIndex.length}`);
    prefetchUpcoming();
  }

  function loadConfig() {
    try { return { ...DEFAULT_CONFIG, ...JSON.parse(localStorage.getItem(CONFIG_KEY) || '{}') }; }
    catch { return { ...DEFAULT_CONFIG }; }
  }
  function saveConfig() { localStorage.setItem(CONFIG_KEY, JSON.stringify(config)); }
  function cleanUrl(url) { return String(url || '').replace(/[?#].*$/, '').replace(/\/+$/, ''); }
  function absUrl(url) { try { return cleanUrl(new URL(url, location.href).href); } catch { return ''; } }

  function parseChapter(url) {
    const clean = absUrl(url);
    if (!clean) return null;
    const match = decodeURIComponent(clean).match(CHAPTER_RE);
    if (!match) return null;
    return { url: clean, key: match[1].toLowerCase(), no: Number(match[2]), raw: match[2] };
  }
  function chapterNo(url) { return displayChapter(url)?.no || 0; }

  function displayChapter(url) {
    const ch = parseChapter(url);
    if (!ch) return null;
    const no = state?.urlNo?.get(ch.url) || ch.no;
    return { ...ch, no, displayNo: no };
  }

  function seriesKey(url) {
    const ch = parseChapter(url);
    if (!ch) return '';
    try {
      const u = new URL(ch.url);
      const parts = u.pathname.split('/').filter(Boolean);
      const idx = parts.findIndex(p => CHAPTER_RE.test('/' + p));
      const keep = idx >= 0 ? parts.slice(0, idx) : parts.slice(0, -1);
      return `${u.origin}/${keep.join('/')}`.toLowerCase();
    } catch { return ''; }
  }
  function sameSeries(url) { return seriesKey(url) === seriesKey(state.currentUrl || initialUrl); }

  function buildChapterIndex(doc) {
    const currentSeries = seriesKey(state?.currentUrl || initialUrl);
    const raw = [...doc.querySelectorAll('a[href], option[value]')]
      .map(el => ({ el, url: absUrl(el.href || el.value), text: normText(el.textContent), textNo: parseChapterText(el.textContent) }))
      .map(item => ({ ...item, ch: parseChapter(item.url) }))
      .filter(item => item.ch && seriesKey(item.url) === currentSeries)
      .map(item => ({ ...item, ch: { ...item.ch, no: item.textNo || item.ch.no, displayNo: item.textNo || item.ch.no } }));

    const byNo = new Map();
    for (const item of raw) {
      state?.urlNo?.set(item.ch.url, item.ch.no);
      const old = byNo.get(item.ch.no);
      if (!old || scoreChapterLink(item) > scoreChapterLink(old)) byNo.set(item.ch.no, item);
    }
    return [...byNo.values()].map(item => item.ch).sort((a, b) => a.no - b.no);
  }

  function scoreChapterLink(item) {
    let score = 0;
    const tag = item.el.tagName;
    if (tag === 'OPTION') score += 10;
    if (/chapter|chuong|chap/.test(item.text)) score += 5;
    if (item.url === item.ch.url) score += 2;
    return score;
  }

  function normText(text) { return String(text || '').toLowerCase().replace(/\s+/g, ' ').trim(); }

  function parseChapterText(text) {
    const match = normText(text).match(/(?:chap|chapter|chuong|chương)\s*(\d+(?:\.\d+)?)/i);
    return match ? Number(match[1]) : null;
  }

  function findExplicitNextUrl(doc = document, baseUrl = state.currentUrl) {
    if (!config.preferNextButton) return null;
    const current = parseChapter(baseUrl);
    if (!current) return null;

    const candidates = [];
    const controls = [...doc.querySelectorAll('a[href], button, .next, [rel="next"]')];
    for (const el of controls) {
      const text = normText(`${el.textContent || ''} ${el.title || ''} ${el.getAttribute('aria-label') || ''} ${el.rel || ''} ${el.className || ''}`);
      if (!/(next|ti[eế]p|sau|chapter-next|chap-next|btn-next|fa-angle-right|rel next)/i.test(text)) continue;
      const href = el.href || el.getAttribute('data-href') || el.getAttribute('onclick')?.match(/https?:[^'" )]+/)?.[0];
      const parsed = parseChapter(href);
      const textNo = parseChapterText(el.textContent || el.title || '');
      const ch = parsed ? { ...parsed, no: textNo || state.urlNo.get(parsed.url) || parsed.no, displayNo: textNo || state.urlNo.get(parsed.url) || parsed.no } : null;
      if (ch && sameSeries(ch.url) && ch.no > current.no && !state.loadedUrls.has(ch.url)) candidates.push(ch);
    }
    return candidates.sort((a, b) => a.no - b.no)[0] || null;
  }

  function nextUrl(url, offset = 1) {
    const current = displayChapter(url);
    if (!current) return null;

    const candidates = new Map();
    const add = ch => {
      if (!ch || ch.no <= current.no || state.loadedUrls.has(ch.url)) return;
      if (state.requestedUrls.has(ch.url) && !state.cache.has(ch.url)) return;
      const old = candidates.get(ch.no);
      if (!old || ch.url.length < old.url.length) candidates.set(ch.no, ch);
    };

    for (const ch of state.chapterIndex) add(ch);
    if (offset === 1) add(findExplicitNextUrl(document, url));

    const ordered = [...candidates.values()].sort((a, b) => a.no - b.no);
    if (ordered[offset - 1]) {
      log('next indexed', { current: current.no, next: ordered[offset - 1].no, all: ordered.slice(0, 5).map(ch => ch.no) });
      return ordered[offset - 1].url;
    }

    if (state.chapterIndex.length) return null;
    const fallback = synthProbeUrls(url).filter(candidate => !state.loadedUrls.has(candidate) && !state.missingUrls.has(candidate));
    return fallback[offset - 1] || null;
  }

  function synthProbeUrls(url) {
    const ch = parseChapter(url);
    if (!ch) return [];
    const urls = [];
    const push = raw => urls.push(cleanUrl(ch.url).replace(CHAPTER_RE, matched => matched.replace(ch.raw, raw)));

    if (ch.raw.includes('.')) {
      const [majorText, minorText] = ch.raw.split('.');
      const major = Number(majorText);
      const minor = Number(minorText);
      const width = minorText.length;
      const scale = 10 ** width;
      for (let nextMinor = minor + 1; nextMinor < scale; nextMinor++) push(`${major}.${String(nextMinor).padStart(width, '0')}`);
      push(String(major + 1));
      return [...new Set(urls)];
    }

    const major = Number(ch.raw);
    for (let minor = 1; minor <= 9; minor++) push(`${major}.${minor}`);
    push(String(major + 1));
    return [...new Set(urls)];
  }

  function imageUrl(img) {
    const srcset = img.getAttribute('srcset') || img.getAttribute('data-srcset') || '';
    const fromSet = srcset.split(',').map(x => x.trim().split(/\s+/)[0]).find(Boolean);
    return img.currentSrc || img.src || img.dataset?.src || img.dataset?.original || img.dataset?.lazySrc || img.getAttribute('data-src') || img.getAttribute('data-original') || img.getAttribute('data-lazy-src') || img.getAttribute('src') || fromSet || '';
  }

  function isBadImage(src) { return /logo|icon|avatar|banner|ads?|thumb|default|loading|sprite|facebook|comment|follow|fanpage|cover|profile|next-chap|muc-luc|description|close|download-chap|back-button|load-more|cmiss-image-preview/i.test(src); }
  function isGoodImage(src) { return /chapter|chuong|chap|manga|manhwa|comic|upload|uploads|wp-content|storage|cdn|image|img/i.test(src); }

  function getComicImages(scope) {
    return [...scope.querySelectorAll('img')].filter(img => {
      const src = imageUrl(img);
      if (!src || isBadImage(src)) return false;
      const w = Number(img.naturalWidth || img.width || img.getAttribute('width') || 0);
      const h = Number(img.naturalHeight || img.height || img.getAttribute('height') || 0);
      const cls = normText(`${img.className || ''} ${img.parentElement?.className || ''}`);
      if (/cmiss-image-preview|player-reader|reader-control|chapter-control|navigation|control|btn|button|popup|modal/.test(cls)) return false;
      return h >= 350 || w >= 500 || /page|chapter|reading|manga|comic|entry-content/.test(cls) || isGoodImage(src);
    });
  }

  function findReaderRoot(doc) {
    const selectors = [
      '#chapter-content', '#chapter_body', '#chapter-images', '#readerarea', '#reader-area', '#reading', '#readchapter',
      '.chapter-content', '.chapter_body', '.chapter-images', '.reading-content', '.reading-detail', '.reader-area', '.readerarea',
      '.entry-content', '.post-content', '.comic-content', '.manga-content', '.container-chapter-reader', '.chapter-c'
    ];
    for (const sel of selectors) {
      const node = doc.querySelector(sel);
      if (node && getComicImages(node).length >= config.minImages) return node;
    }

    const images = getComicImages(doc);
    if (!images.length) return null;
    let best = null, bestScore = -Infinity;
    for (const image of images) {
      let node = image.parentElement;
      while (node && node !== doc.body) {
        if (/comment|footer|header|nav|sidebar|related|recommend|fanpage|profile|player-reader|reader-control|chapter-control|cmiss-entity-preview|popup|modal/i.test(node.id + ' ' + node.className)) { node = node.parentElement; continue; }
        const comic = getComicImages(node).length;
        const all = node.querySelectorAll?.('img').length || 0;
        const textPenalty = Math.min(80, (node.innerText || '').length / 250);
        const score = comic * 20 - Math.max(0, all - comic) * 8 - textPenalty;
        if (score > bestScore) { bestScore = score; best = node; }
        node = node.parentElement;
      }
    }
    return best || images[0].parentElement || null;
  }

  function getChapterBlocks(doc) {
    const root = findReaderRoot(doc);
    if (!root) return [];
    sanitizeNode(root);
    const images = getComicImages(root);
    if (images.length < config.minImages) return [];
    const blocks = images.map(img => img.closest('p, figure, .page, .chapter-image, .reading-detail, .separator, .center, .image, .manga-page') || img.parentElement || img);
    return [...new Set(blocks)];
  }

  async function prefetchUpcoming() {
    prunePrefetchCache();
    if (!config.enabled || state.ended) return;
    for (let offset = 1; offset <= config.prefetchAhead; offset++) {
      const url = nextUrl(state.currentUrl, offset);
      if (shouldFetch(url)) fetchChapter(url, true).catch(err => log('prefetch fail', url, err.message));
    }
  }
  function prunePrefetchCache() {
    const current = chapterNo(state.currentUrl);
    for (const [url] of state.cache) if (chapterNo(url) <= current) state.cache.delete(url);
  }
  function shouldFetch(url) { return Boolean(url && !state.loadedUrls.has(url) && !state.cache.has(url) && !state.inFlight.has(url) && !state.requestedUrls.has(url)); }

  async function fetchChapter(url, prefetch = false) {
    url = cleanUrl(url);
    if (state.cache.has(url)) return state.cache.get(url);
    if (state.inFlight.has(url)) return state.inFlight.get(url);
    state.requestedUrls.add(url);

    const promise = retry(async () => {
      const res = await fetch(url, { credentials: 'include', headers: { accept: 'text/html,application/xhtml+xml' } });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const doc = new DOMParser().parseFromString(await res.text(), 'text/html');
      const parsed = parseChapter(url);
      const displayNo = state.urlNo.get(url) || parsed.no;
      const blocks = getChapterBlocks(doc);
      if (!blocks.length) throw new Error('Không tìm thấy ảnh chương');
      mergeChapterIndex(buildChapterIndex(doc));
      const data = { url, no: displayNo, title: doc.title || `Chương ${displayNo}`, blocks };
      state.cache.set(url, data);
      log(prefetch ? 'prefetched' : 'fetched', { no: data.no, url, blocks: blocks.length });
      return data;
    }, config.retryCount, config.retryDelay);

    state.inFlight.set(url, promise);
    try { return await promise; }
    finally { state.inFlight.delete(url); if (!state.cache.has(url)) state.requestedUrls.delete(url); }
  }

  function mergeChapterIndex(items) {
    const byNo = new Map(state.chapterIndex.map(item => [item.no, item]));
    for (const item of items) if (!byNo.has(item.no)) byNo.set(item.no, item);
    state.chapterIndex = [...byNo.values()].sort((a, b) => a.no - b.no);
  }
  async function retry(task, count, delay) {
    let lastError;
    for (let attempt = 0; attempt <= count; attempt++) {
      try { return await task(); }
      catch (error) { lastError = error; if (attempt < count) await sleep(delay * (attempt + 1)); }
    }
    throw lastError;
  }
  function sleep(ms) { return new Promise(resolve => setTimeout(resolve, ms)); }

  async function appendNextChapter(manual = false) {
    const now = Date.now();
    if (!config.enabled || state.busy || state.ended) return;
    if (!manual && (state.autoLocked || now - state.lastAutoAt < 1400)) return;

    state.busy = true;
    state.lastAutoAt = now;

    try {
      for (let attempt = 0; attempt < 12; attempt++) {
        const url = nextUrl(state.currentUrl);
        const no = chapterNo(url || '');
        if (!url || state.loadedUrls.has(url)) {
          state.ended = !url;
          if (!url) toast('Không tìm thấy chap tiếp.');
          return;
        }

        setBusy(true, `Đang dò chương ${no}...`);
        try {
          const data = await fetchChapter(url, false);
          if (data.no <= chapterNo(state.currentUrl)) throw new Error(`Chap lùi/sai thứ tự: ${data.no}`);
          renderChapter(data);
          state.currentUrl = data.url;
          state.loadedUrls.add(data.url);
          state.requestedUrls.delete(data.url);
          state.missingUrls.delete(data.url);
          if (config.updateUrl) history.replaceState(null, '', data.url);
          setBusy(false, `Đã nối chương ${data.no}.`);
          state.autoLocked = !manual;
          state.lastAppendScrollY = scrollY;
          moveSentinelToReaderEnd();
          prefetchUpcoming();
          return;
        } catch (error) {
          state.requestedUrls.delete(url);
          if (/HTTP 404|Không tìm thấy ảnh|HTTP 403|HTTP 410/i.test(error.message)) {
            state.missingUrls.add(url);
            log('skip missing chap', { no, url, error: error.message });
            continue;
          }
          setBusy(false, `Lỗi chương ${no}: ${error.message}`);
          log('append error', { url, error: error.message });
          return;
        }
      }
      toast('Không tìm thấy chap tiếp sau khi dò.');
    } finally { state.busy = false; }
  }

  function renderChapter(data) {
    const fragment = document.createDocumentFragment();
    fragment.appendChild(createDivider(data.no));
    for (const block of data.blocks) fragment.appendChild(block.cloneNode(true));
    if (state.sentinel?.parentElement === state.root) state.sentinel.remove();
    state.root.appendChild(fragment);
  }

  function sanitizeNode(node) {
    node.querySelectorAll?.('[id]').forEach(el => el.removeAttribute('id'));
    if (config.removeAds) node.querySelectorAll?.('script, iframe, ins, [data-cl-spot], [data-zone], [data-id], .ads, .ad, .advertisement, .banner, .quangcao, .comments, #comments, footer, nav').forEach(el => el.remove());
    node.querySelectorAll?.('img').forEach(img => {
      const lazy = imageUrl(img);
      if (lazy && (!img.getAttribute('src') || /loading|blank|placeholder/i.test(img.getAttribute('src')))) img.src = lazy;
      img.loading = 'lazy'; img.decoding = 'async'; img.removeAttribute('fetchpriority'); img.style.maxWidth = '100%'; img.style.height = 'auto';
    });
  }
  function hydrateInitialImages() { document.querySelectorAll('img').forEach(img => { img.decoding = 'async'; if (!isInViewport(img)) img.loading = 'lazy'; }); }
  function isInViewport(el) { const r = el.getBoundingClientRect(); return r.top < innerHeight && r.bottom > 0; }
  function createDivider(no) { const div = document.createElement('div'); div.className = 'ac-ir-divider'; div.innerHTML = `<span>Chương ${no}</span>`; return div; }

  function setupObserver() {
    const sentinel = document.createElement('div'); sentinel.id = 'ac-ir-sentinel'; state.sentinel = sentinel; moveSentinelToReaderEnd();
    new IntersectionObserver(entries => { if (entries.some(e => e.isIntersecting)) appendNextChapter(false); }, { rootMargin: `${config.triggerDistance}px 0px` }).observe(sentinel);
  }
  function moveSentinelToReaderEnd() { if (state.sentinel && state.root) state.root.appendChild(state.sentinel); }
  function setupScrollFallback() {
    let ticking = false;
    window.addEventListener('scroll', () => {
      if (ticking) return; ticking = true;
      requestAnimationFrame(() => {
        ticking = false;
        const pageHeight = Math.max(document.body.scrollHeight, document.documentElement.scrollHeight);
        const readerBottom = (state.root?.getBoundingClientRect?.().bottom || pageHeight) + scrollY;
        if (state.autoLocked && scrollY > state.lastAppendScrollY + 700) state.autoLocked = false;
        updateProgress(pageHeight);
        if (innerHeight + scrollY > readerBottom - config.triggerDistance) appendNextChapter(false);
      });
    }, { passive: true });
  }
  function updateProgress(pageHeight) { ui.progress.style.width = `${Math.min(100, Math.max(0, (scrollY / Math.max(1, pageHeight - innerHeight)) * 100))}%`; }

  function createUI() {
    const dock = el('div', 'ac-ir-dock');
    const fab = el('button', 'ac-ir-fab', '<span>∞</span>'); fab.type = 'button';
    const sheet = el('div', 'ac-ir-sheet');
    const message = el('div', 'ac-ir-message');
    const toggle = btn('', 'ac-ir-toggle', toggleEnabled);
    const next = btn('Tải chương tiếp', 'ac-ir-next', () => appendNextChapter(true));
    const prefetchRange = makeRange('ac-ir-prefetch', 'Tải trước', 0, 5, config.prefetchAhead, 'chap', v => { config.prefetchAhead = v; saveConfig(); prefetchUpcoming(); });
    const distRange = makeRange('ac-ir-dist', 'Khoảng cách', 1200, 5000, config.triggerDistance, 'px', v => { config.triggerDistance = v; saveConfig(); });
    const chapList = btn('Danh sách', 'ac-ir-chaplist', toggleChapList);
    const nextLink = el('div', 'ac-ir-nextlink');
    const updateUrl = btn('', 'ac-ir-url', () => { config.updateUrl = !config.updateUrl; saveConfig(); syncUI(); });
    const reset = btn('Reset mặc định', 'ac-ir-reset', () => {
      state.cache.clear();
      state.inFlight.clear();
      state.requestedUrls.clear();
      state.missingUrls.clear();
      state.ended = false;
      state.autoLocked = false;
      Object.assign(config, DEFAULT_CONFIG);
      saveConfig();
      syncUI();
      toast('Đã reset về mặc định!');
    });
    const progress = el('div', 'ac-ir-progress'); const bar = el('div', 'ac-ir-progress-bar'); progress.append(bar);
    fab.onclick = e => { e.stopPropagation(); dock.classList.toggle('open'); };
    sheet.onclick = e => e.stopPropagation();
    document.addEventListener('pointerdown', e => {
      if (!dock.contains(e.target)) {
        dock.classList.remove('open');
        document.getElementById('ac-ir-chapters')?.remove();
      }
    }, { passive: true });
    sheet.append(el('div', 'ac-ir-title', 'AutoChange'), message, toggle, chapList, next, nextLink, prefetchRange.wrap, distRange.wrap, updateUrl, reset, progress);
    dock.append(fab, sheet); document.body.appendChild(dock);
    const refs = { dock, fab, message, toggle, chapList, nextLink, prefetchRange: prefetchRange.label, distRange: distRange.label, updateUrl, progress: bar }; syncUI(refs); return refs;
  }
  function el(tag, id, html = '') { const node = document.createElement(tag); node.id = id; node.innerHTML = html; return node; }
  function btn(text, id, onclick) { const b = el('button', id, text); b.type = 'button'; b.onclick = onclick; return b; }

  function makeRange(id, label, min, max, value, suffix, onChange) {
    const wrap = el('div', id + '-wrap'); wrap.className = 'ac-ir-range';
    const top = el('div', '');
    const name = el('span', '', label);
    const valueEl = el('b', id + '-val', `${value} ${suffix}`);
    const input = document.createElement('input'); input.type = 'range'; input.id = id; input.min = min; input.max = max; input.value = value;
    input.oninput = () => { const v = Number(input.value); valueEl.textContent = `${v} ${suffix}`; onChange(v); };
    top.append(name, valueEl); wrap.append(top, input); return { wrap, input, label: valueEl };
  }

  function toggleEnabled() { config.enabled = !config.enabled; saveConfig(); syncUI(); toast(config.enabled ? 'AutoChange: ON.' : 'AutoChange: OFF.'); if (config.enabled) prefetchUpcoming(); }

  function toggleChapList() {
    let box = document.getElementById('ac-ir-chapters');
    if (box) { box.remove(); return; }
    box = el('div', 'ac-ir-chapters');

    const currentNo = chapterNo(state.currentUrl);
    const loaded = [...state.loadedUrls].map(url => ({ url, no: chapterNo(url), type: 'loaded' }));
    const indexed = state.chapterIndex.map(ch => ({ url: ch.url, no: ch.no, type: 'available' }));
    const rows = [...new Map([...loaded, ...indexed].sort((a, b) => a.no - b.no).map(ch => [`${ch.no}|${ch.url}`, ch])).values()];

    if (!rows.length) {
      box.innerHTML = '<div class="ac-ir-chap-empty"><p>📚 Chưa có danh sách chương</p></div>';
    } else {
      const header = '<div class="ac-ir-chap-header"><span>📖 Danh sách chương</span><small>' + rows.length + ' chương</small></div>';
      const list = rows.map(ch => {
        const isCurrent = ch.no === currentNo;
        const isLoaded = ch.type === 'loaded';
        const cls = `ac-ir-chap-item${isCurrent ? ' current' : ''}${isLoaded ? ' loaded' : ''}`;
        const dot = isLoaded ? '●' : '○';
        const label = isLoaded ? 'Đã tải' : 'Có sẵn';
        return `<a href="${ch.url}" class="${cls}"><span class="ac-ir-chap-dot">${dot}</span><span class="ac-ir-chap-no">Chương ${ch.no}</span><small>${label}</small></a>`;
      }).join('');
      box.innerHTML = header + '<div class="ac-ir-chap-list">' + list + '</div>';
    }

    const sheet = ui.dock.querySelector('#ac-ir-sheet');
    sheet.appendChild(box);

    // Tự động cuộn đến chương hiện tại
    setTimeout(() => {
      const activeItem = box.querySelector('.ac-ir-chap-item.current');
      if (activeItem) activeItem.scrollIntoView({ block: 'center', behavior: 'smooth' });
      // Cuộn cả panel lên để thấy danh sách
      box.scrollIntoView({ block: 'end', behavior: 'smooth' });
    }, 100);
  }

  function syncUI(refs = ui) {
    refs.toggle.textContent = `Tự động: ${config.enabled ? 'ON' : 'OFF'}`;
    refs.prefetchRange.textContent = `${config.prefetchAhead} chap`;
    refs.distRange.textContent = `${config.triggerDistance} px`;
    const next = nextUrl(state.currentUrl);
    refs.nextLink.innerHTML = next ? `Đọc tiếp: <a href="${next}">Chap ${chapterNo(next)}</a>` : 'Đọc tiếp: chưa rõ';
    refs.updateUrl.textContent = `Đổi URL: ${config.updateUrl ? 'ON' : 'OFF'}`;
    refs.fab.classList.toggle('on', config.enabled); refs.toggle.classList.toggle('on', config.enabled);
  }
  function setBusy(isBusy, text) { ui.dock.classList.toggle('busy', isBusy); toast(text); }
  function toast(text) { ui.message.textContent = text; ui.dock.classList.add('show'); clearTimeout(toast.timer); toast.timer = setTimeout(() => { if (!state.busy) ui.dock.classList.remove('show'); }, 3200); }
  function log(...args) { if (config.debug) console.log('[AutoChange]', ...args); }
  function nodeLabel(node) { return node ? `${node.tagName?.toLowerCase()}#${node.id || ''}.${String(node.className || '').replace(/\s+/g, '.')}` : 'null'; }

  function installStyles() {
    const style = document.createElement('style');
    style.textContent = `
      #ac-ir-dock{position:fixed;right:16px;bottom:96px;z-index:2147483647;font-family:'Inter','Segoe UI',system-ui,sans-serif;color:#fff;-webkit-font-smoothing:antialiased}

      /* FAB Button */
      #ac-ir-fab{width:42px;height:42px;border:none;border-radius:50%;color:#fff;background:linear-gradient(135deg,#6366f1,#8b5cf6);font-size:22px;font-weight:900;box-shadow:0 4px 15px rgba(99,102,241,.45);cursor:pointer;opacity:.9;transition:all .25s ease}
      #ac-ir-fab:hover{opacity:1;transform:scale(1.08);box-shadow:0 6px 20px rgba(99,102,241,.55)}
      #ac-ir-fab.on{background:linear-gradient(135deg,#10b981,#059669);box-shadow:0 4px 15px rgba(16,185,129,.45)}
      @keyframes ac-ir-pulse{0%,100%{box-shadow:0 4px 15px rgba(16,185,129,.45)}50%{box-shadow:0 4px 25px rgba(16,185,129,.7)}}
      #ac-ir-fab.on{animation:ac-ir-pulse 2s ease-in-out infinite}

      /* Sheet Panel */
      #ac-ir-sheet{position:absolute;right:0;bottom:52px;width:min(340px,calc(100vw - 32px));max-height:75vh;overflow-y:auto;display:grid;grid-template-columns:1fr 1fr;gap:8px;padding:14px 12px;border:1px solid rgba(255,255,255,.12);border-radius:20px;backdrop-filter:blur(20px) saturate(180%);-webkit-backdrop-filter:blur(20px) saturate(180%);background:rgba(30,30,40,.82);box-shadow:0 16px 48px rgba(0,0,0,.55),0 0 0 1px rgba(255,255,255,.05) inset;transform:translateY(12px) scale(.95);transform-origin:bottom right;opacity:0;pointer-events:none;transition:all .22s cubic-bezier(.4,0,.2,1);scrollbar-width:thin;scrollbar-color:rgba(255,255,255,.15) transparent;align-content:start}
      #ac-ir-sheet::-webkit-scrollbar{width:5px}#ac-ir-sheet::-webkit-scrollbar-track{background:transparent}#ac-ir-sheet::-webkit-scrollbar-thumb{background:rgba(255,255,255,.15);border-radius:9px}
      #ac-ir-dock.open #ac-ir-sheet{transform:translateY(0) scale(1);opacity:1;pointer-events:auto}

      /* Title & Message */
      #ac-ir-title,#ac-ir-message,#ac-ir-next,#ac-ir-reset,#ac-ir-progress{grid-column:1/-1}
      #ac-ir-title{font-size:15px;font-weight:900;color:#e0e7ff;letter-spacing:-.02em;text-align:center;padding-bottom:4px;border-bottom:1px solid rgba(255,255,255,.08)}
      #ac-ir-message{min-height:22px;color:rgba(255,255,255,.72);font-size:12px;line-height:1.5;text-align:center;padding:4px 8px;background:rgba(255,255,255,.04);border-radius:8px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}

      /* Buttons */
      #ac-ir-sheet button{border:1px solid rgba(255,255,255,.1);border-radius:12px;padding:10px 10px;color:rgba(255,255,255,.88);background:rgba(255,255,255,.06);font-size:12px;font-weight:700;cursor:pointer;transition:all .15s ease;letter-spacing:.01em}
      #ac-ir-sheet button:hover{background:rgba(255,255,255,.12);border-color:rgba(255,255,255,.18);transform:translateY(-1px);box-shadow:0 4px 12px rgba(0,0,0,.25)}
      #ac-ir-sheet button:active{transform:translateY(0);background:rgba(255,255,255,.04)}
      #ac-ir-toggle.on{background:linear-gradient(135deg,#10b981,#059669)!important;color:#fff;border-color:transparent!important;box-shadow:0 2px 8px rgba(16,185,129,.3)}
      #ac-ir-next{background:linear-gradient(135deg,#6366f1,#8b5cf6)!important;color:#fff;border-color:transparent!important}
      #ac-ir-next:hover{background:linear-gradient(135deg,#818cf8,#a78bfa)!important}
      #ac-ir-chaplist{background:linear-gradient(135deg,#f59e0b,#d97706)!important;color:#fff;border-color:transparent!important}
      #ac-ir-chaplist:hover{background:linear-gradient(135deg,#fbbf24,#f59e0b)!important}
      #ac-ir-reset{background:rgba(239,68,68,.15)!important;color:#f87171!important;border-color:rgba(239,68,68,.25)!important;margin-top:2px}
      #ac-ir-reset:hover{background:rgba(239,68,68,.25)!important;color:#fca5a5!important}
      #ac-ir-url{background:rgba(99,102,241,.15)!important;color:#a5b4fc!important;border-color:rgba(99,102,241,.2)!important}
      #ac-ir-url:hover{background:rgba(99,102,241,.25)!important}

      /* Range Sliders */
      .ac-ir-range{display:flex;flex-direction:column;gap:4px}
      .ac-ir-range > div:first-child{display:flex;justify-content:space-between;align-items:center;font-size:11px;color:rgba(255,255,255,.65)}
      .ac-ir-range b{color:rgba(255,255,255,.9);font-size:12px}
      .ac-ir-range input[type=range]{-webkit-appearance:none;appearance:none;width:100%;height:6px;border-radius:9px;background:rgba(255,255,255,.1);outline:none;cursor:pointer}
      .ac-ir-range input[type=range]::-webkit-slider-thumb{-webkit-appearance:none;width:16px;height:16px;border-radius:50%;background:linear-gradient(135deg,#6366f1,#8b5cf6);box-shadow:0 2px 6px rgba(99,102,241,.4);cursor:pointer;transition:transform .15s ease}
      .ac-ir-range input[type=range]::-webkit-slider-thumb:hover{transform:scale(1.15)}
      .ac-ir-range input[type=range]::-moz-range-thumb{width:16px;height:16px;border-radius:50%;background:linear-gradient(135deg,#6366f1,#8b5cf6);border:none;box-shadow:0 2px 6px rgba(99,102,241,.4);cursor:pointer}

      /* Progress Bar */
      #ac-ir-progress{height:4px;background:rgba(255,255,255,.08);border-radius:99px;overflow:hidden;margin-top:4px}
      #ac-ir-progress-bar{width:0;height:100%;background:linear-gradient(90deg,#6366f1,#8b5cf6,#a78bfa);border-radius:99px;transition:width .3s ease}

      /* Chapter List */
      #ac-ir-chapters{grid-column:1/-1;margin-top:6px;background:rgba(0,0,0,.15);border-radius:12px;padding:4px}
      .ac-ir-chap-header{display:flex;justify-content:space-between;align-items:center;padding:8px 10px;font-size:13px;font-weight:800;color:#e0e7ff;border-bottom:1px solid rgba(255,255,255,.08)}
      .ac-ir-chap-header small{font-weight:500;color:rgba(255,255,255,.5);font-size:11px}
      .ac-ir-chap-empty{text-align:center;padding:16px;color:rgba(255,255,255,.6);font-size:13px}
      .ac-ir-chap-list{display:flex;flex-direction:column;gap:2px;max-height:260px;overflow-y:auto;padding:6px 2px;scrollbar-width:thin;scrollbar-color:rgba(255,255,255,.12) transparent}
      .ac-ir-chap-list::-webkit-scrollbar{width:4px}#ac-ir-chap-list::-webkit-scrollbar-track{background:transparent}#ac-ir-chap-list::-webkit-scrollbar-thumb{background:rgba(255,255,255,.12);border-radius:9px}
      .ac-ir-chap-item{display:flex;align-items:center;gap:8px;padding:7px 10px;border-radius:8px;color:rgba(255,255,255,.8);font-size:12px;font-weight:600;text-decoration:none;transition:all .12s ease;cursor:pointer}
      .ac-ir-chap-item:hover{background:rgba(255,255,255,.08);color:#fff}
      .ac-ir-chap-item.current{background:linear-gradient(135deg,rgba(99,102,241,.25),rgba(139,92,246,.2));color:#e0e7ff;border:1px solid rgba(99,102,241,.3)}
      .ac-ir-chap-item.loaded .ac-ir-chap-dot{color:#10b981}
      .ac-ir-chap-dot{font-size:8px;color:rgba(255,255,255,.25);flex-shrink:0;transition:color .15s ease}
      .ac-ir-chap-item.current .ac-ir-chap-dot{color:#8b5cf6}
      .ac-ir-chap-no{flex:1}
      .ac-ir-chap-item small{color:rgba(255,255,255,.4);font-size:10px;font-weight:500}
      #ac-ir-chapters a[href]{text-decoration:none!important;color:inherit!important}

      /* Next Link */
      #ac-ir-nextlink{text-align:center;font-size:11px;color:rgba(255,255,255,.55);padding:2px 0}
      #ac-ir-nextlink a{color:#a5b4fc!important;text-decoration:underline!important;text-decoration-color:rgba(165,180,252,.3)!important}
      #ac-ir-nextlink a:hover{color:#c7d2fe!important}

      /* Chapter Divider */
      .ac-ir-divider{position:relative;margin:44px auto 24px;max-width:920px;padding:0 16px;text-align:center}
      .ac-ir-divider:before{content:"";position:absolute;left:16px;right:16px;top:50%;height:1px;background:linear-gradient(90deg,transparent,rgba(255,255,255,.2),transparent)}
      .ac-ir-divider span{position:relative;display:inline-flex;padding:10px 20px;border:1px solid rgba(99,102,241,.25);border-radius:999px;color:#e0e7ff;background:rgba(30,30,40,.9);font-size:18px;font-weight:900;box-shadow:0 8px 24px rgba(99,102,241,.15);backdrop-filter:blur(8px);-webkit-backdrop-filter:blur(8px)}

      /* Sentinel & Misc */
      #ac-ir-sentinel{height:1px}
      #ac-ir-dock.busy #ac-ir-fab{opacity:1;transform:scale(1.1)}

      /* Mobile */
      @media(max-width:560px){
        #ac-ir-dock{right:12px;bottom:max(94px,calc(94px + env(safe-area-inset-bottom)))}
        #ac-ir-sheet{position:fixed;left:10px;right:10px;bottom:max(136px,calc(136px + env(safe-area-inset-bottom)));width:auto;max-height:60vh;transform-origin:bottom center}
        #ac-ir-fab{width:38px;height:38px;font-size:20px}
      }
    `;
    document.head.appendChild(style);
  }
})();




