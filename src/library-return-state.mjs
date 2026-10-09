// A per-tab, short-lived UI snapshot: no video bytes, DOM or permanent files.
export function parseLibraryReturnState(raw, currentUrl, now = Date.now()) {
  try {
    const state = typeof raw === 'string' ? JSON.parse(raw) : raw;
    const normalize = value => {
      const url = new URL(value, currentUrl);
      if (!['/playlist', '/recommend'].includes(url.pathname)) return '';
      url.searchParams.delete('access_token');
      url.searchParams.delete('token');
      url.searchParams.sort();
      return url.origin + url.pathname + url.search;
    };
    if (!state || state.version !== 1 || !Number.isFinite(state.savedAt)
      || now - state.savedAt > 30 * 60 * 1000 || state.savedAt > now + 60_000
      || !normalize(currentUrl) || normalize(state.url) !== normalize(currentUrl)
      || !Array.isArray(state.items) || !state.items.length || state.items.length > 3000
      || !Number.isInteger(state.page) || state.page < 1
      || !Number.isFinite(state.total) || state.total < state.items.length) return null;
    const ids = new Set();
    for (const item of state.items) {
      if (!item || typeof item.id !== 'string' || !item.id || item.id.length > 200 || ids.has(item.id)) return null;
      ids.add(item.id);
    }
    return state;
  } catch { return null; }
}

export function libraryReturnStateScript() {
  return [parseLibraryReturnState, readLibraryReturnState, captureLibraryReturnState, restoreLibraryReturnState]
    .map(fn => fn.toString()).join('\n') + '\nlet libraryReturnState = readLibraryReturnState();\n'
    + installReturnLifecycle.toString() + '\ninstallReturnLifecycle();';
}

function readLibraryReturnState() {
  if (!['/playlist', '/recommend'].includes(location.pathname)) return null;
  try {
    const state = parseLibraryReturnState(sessionStorage.getItem('iwara-library-return'), location.href);
    if (state) sessionStorage.removeItem('iwara-library-return');
    return state;
  } catch { return null; }
}

function captureLibraryReturnState(playedIndex) {
  if (singleVideoMode || !items.length) return;
  const cardNodes = [...document.querySelectorAll('#grid .card')];
  const top = Math.max(0, document.querySelector('header')?.getBoundingClientRect().bottom || 0);
  const anchor = cardNodes.find(node => node.getBoundingClientRect().bottom > top) || cardNodes[0];
  const fields = ['id', 'videoId', 'title', 'author', 'alias', 'uploadTime', 'views', 'streamUrl', 'coverUrl',
    'downloadUrl', 'playbackProfile', 'localFileName', 'playbackPosition', 'playbackDuration', 'watched',
    'favorite', 'watchLater', 'queuePosition', 'discarded', 'sourcePage'];
  const url = new URL(location.href);
  url.searchParams.delete('access_token');
  url.searchParams.delete('token');
  const state = {
    version: 1, savedAt: Date.now(), url: url.href,
    page: pageNo, total: totalItems, seed: shuffleSeed, author: $('authorFilter').value,
    scrollY: window.scrollY, anchorId: items[Number(anchor?.dataset.index)]?.id,
    anchorOffset: anchor?.getBoundingClientRect().top || 0, playedId: items[playedIndex]?.id,
    items: items.map(item => Object.fromEntries(fields.filter(key => item[key] !== undefined).map(key => [key, item[key]])))
  };
  try {
    const encoded = JSON.stringify(state);
    if (encoded.length > 4_000_000) return;
    sessionStorage.setItem('iwara-library-return', encoded);
    window.__iwaraReturnSaved = true;
  } catch { /* Storage denied/full: the existing source URL remains the fallback. */ }
}

function restoreLibraryReturnState(state) {
  items = state.items;
  pageNo = state.page;
  totalItems = state.total;
  shuffleSeed = String(state.seed || '');
  current = -1;
  initialLoad = false;
  loading = true; // Do not let the sentinel load/reshape the list before its anchor is restored.
  if (state.author && state.author !== 'all') {
    const author = $('authorFilter');
    if (![...author.options].some(option => option.value === state.author)) author.add(new Option(state.author, state.author));
    author.value = state.author;
  }
  render();
  syncListUrl();
  _updateMobileFilterSummary();
  $('status').textContent = '已返回刚才浏览的位置。';
  requestAnimationFrame(() => requestAnimationFrame(() => {
    const index = items.findIndex(item => item.id === state.anchorId);
    const anchor = [...document.querySelectorAll('#grid .card')].find(node => Number(node.dataset.index) === index);
    const y = anchor ? window.scrollY + anchor.getBoundingClientRect().top - Number(state.anchorOffset || 0) : Number(state.scrollY || 0);
    window.scrollTo(0, Math.max(0, y));
    loading = false;
    window.__iwaraReturnSaved = false;
  }));
  // Refresh just the opened video's progress/flags, keeping the cached order
  // and random batch intact. The rest is lightweight text and resource tickets.
  if (state.playedId) {
    const params = new URLSearchParams({contextId:state.playedId,contextSize:'1',pageSize:'1',discarded:'all',profile:playbackProfile});
    void fetch('/playlist-data?' + params, {cache:'no-store'}).then(async response => {
      if (!response.ok) return;
      const data = await response.json();
      const fresh = data.items?.find(item => item.id === state.playedId);
      const old = items.find(item => item.id === state.playedId);
      if (!fresh || !old) return;
      Object.assign(old, fresh);
      if (fresh.discarded && $('libraryFilter').value !== 'discarded') {
        items = items.filter(item => item.id !== fresh.id);
        totalItems = Math.max(items.length, totalItems - 1);
      }
      render();
    }).catch(() => {});
  }
}

function installReturnLifecycle() {
  // Keep only small progress/flag deltas while the player runs. Serialize the
  // list once on exit, not on every timeupdate; audio-only does not add progress.
  const deltas = new Map();
  const remember = task => {
    if (!singleVideoMode || !task?.id) return;
    const keys = ['playbackPosition','playbackDuration','watched','favorite','watchLater','queuePosition','discarded'];
    deltas.set(task.id,Object.fromEntries(keys.filter(key => task[key] !== undefined).map(key => [key,task[key]])));
  };
  const originalPersist = persistPlayback;
  persistPlayback = (...args) => {
    const result = originalPersist(...args);
    if (!audioOnly) remember(items[current]);
    return result;
  };
  const originalFlags = updatePlaylistFlag;
  updatePlaylistFlag = async (...args) => {
    const result = await originalFlags(...args);
    if (result) remember(items.find(item => item.id === args[0]));
    return result;
  };
  window.addEventListener('pagehide', () => {
    if (singleVideoMode) {
      try {
        const state = parseLibraryReturnState(sessionStorage.getItem('iwara-library-return'),new URL(sourcePage,location.origin).href);
        if (!state) return;
        const task = items[current], video = $('mainVideo');
        remember(task);
        if (task && !audioOnly && Number.isFinite(video.duration) && video.duration > 0) {
          Object.assign(deltas.get(task.id),{playbackPosition:video.currentTime,playbackDuration:video.duration,watched:Boolean(video.ended || video.currentTime/video.duration >= .95)});
        }
        for (const item of state.items) if (deltas.has(item.id)) Object.assign(item,deltas.get(item.id));
        if (task) state.playedId = task.id;
        sessionStorage.setItem('iwara-library-return',JSON.stringify(state));
      } catch {}
      return;
    }
    if (singleVideoMode || !window.__iwaraReturnSaved) return;
    items = [];
    $('grid').replaceChildren();
    if (typeof gridNodes !== 'undefined') gridNodes.clear();
    if (typeof listRequestController !== 'undefined') listRequestController?.abort();
    loadObserver?.disconnect();
    if (typeof coverObserver !== 'undefined') { coverObserver?.disconnect(); coverObserver = null; }
  });
  window.addEventListener('pageshow', event => {
    if (!event.persisted || singleVideoMode) return;
    const state = readLibraryReturnState();
    if (state) { setupInfiniteScroll(); restoreLibraryReturnState(state); }
  });
}
