// Progressive enhancement of the library only. The existing mobile controls,
// downloader and standalone player keep their own DOM and event handlers.
export function desktopLibraryEnhancementScript() {
  return `(${enhanceDesktopLibrary.toString()})();`;
}

function enhanceDesktopLibrary() {
  const desktop = matchMedia('(min-width:601px)');
  const header = document.querySelector('header');
  if (!header || singleVideoMode) return;
  let active = false;
  const slots = new Map();
  const originalTitle = $('pageTitle').textContent;
  const originalPlaceholder = $('query').placeholder;
  const style = document.createElement('style');
  style.textContent = `
    .desktop-library-only{display:none}
    @media(min-width:601px){
      body.desktop-library-ui{background:#f7f9fc}
      .desktop-library-ui header{padding:0 24px;display:block;z-index:30;border-bottom:1px solid #e8edf4;background:#fff;backdrop-filter:none}
      .desktop-library-ui .desktop-nav-inner{display:grid;grid-template-columns:auto minmax(120px,1fr) auto;align-items:center;gap:28px;max-width:1600px;min-height:68px;margin:auto}
      .desktop-library-ui header h1{margin:0;font-size:21px;white-space:nowrap}
      .desktop-library-ui header>*,.desktop-library-ui #qualityMode{display:none!important}
      .desktop-library-ui header>.desktop-nav-inner{display:grid!important}
      .desktop-library-ui .desktop-search{position:relative;width:min(580px,100%);justify-self:center;min-width:0}
      .desktop-library-ui .desktop-search svg{position:absolute;left:13px;top:12px;width:18px;height:18px;color:#8795a9;pointer-events:none}
      .desktop-library-ui .desktop-search #query{width:100%;min-width:0;height:42px;padding:9px 37px 9px 39px;border:1px solid #e1e7ef;border-radius:12px;background:#f5f7fa;outline:none}
      .desktop-library-ui .desktop-search #query:focus{background:#fff;border-color:#6d99e5;box-shadow:0 0 0 3px #eaf1fe}
      .desktop-library-ui .desktop-search-clear{position:absolute;right:6px;top:5px;width:32px;min-height:32px;padding:0;border:0;background:transparent;color:#7a899c;font-size:19px}
      .desktop-library-ui .desktop-nav-actions{display:flex;align-items:center;gap:10px}
      .desktop-library-ui #qualityToggle,.desktop-library-ui #ledgerLink button{min-height:38px;padding:8px 12px;border-color:#e1e7ef;font-size:13px;font-weight:500;white-space:nowrap}
      .desktop-library-ui #qualityToggle{background:#eef4ff;border-color:transparent;color:#3f6da9}
      .desktop-library-ui .desktop-library-bar{display:flex;align-items:center;flex-wrap:wrap;gap:12px;max-width:1648px;margin:auto;padding:12px 24px 10px}
      .desktop-library-ui .desktop-library-tabs{display:flex;gap:23px;align-items:center;flex-shrink:0}
      .desktop-library-ui .desktop-library-tabs a{color:#7a879a;text-decoration:none;padding:7px 0;font-size:14px;font-weight:500;border-bottom:2px solid transparent;white-space:nowrap}
      .desktop-library-ui .desktop-library-tabs a[aria-current=page]{color:#285fa9;border-bottom-color:#4d83e6;font-weight:650}
      .desktop-library-ui .desktop-library-total{font-size:12px;color:#8a96a7;white-space:nowrap}
      .desktop-library-ui .desktop-library-tools{display:flex;align-items:center;gap:7px;margin-left:auto;flex-wrap:wrap;justify-content:flex-end}
      .desktop-library-ui .desktop-library-tools button,.desktop-library-ui .desktop-library-tools select,.desktop-library-ui .desktop-menu>summary{min-height:36px;font-size:12px;font-weight:500;border-color:#e3e9f1;padding:7px 10px;border-radius:9px;white-space:nowrap;background:#fff;color:#52647d}
      .desktop-library-ui .desktop-library-tools select{max-width:164px;cursor:pointer}
      .desktop-library-ui .desktop-menu{position:relative}
      .desktop-library-ui .desktop-menu>summary{list-style:none;cursor:pointer;display:flex;align-items:center;gap:6px;border:1px solid #e3e9f1;user-select:none}
      .desktop-library-ui .desktop-menu>summary::-webkit-details-marker{display:none}
      .desktop-library-ui .desktop-menu>summary::after{content:'⌄';color:#8896a8;font-size:13px}
      .desktop-library-ui .desktop-menu[open]>summary,.desktop-library-ui .desktop-menu>summary:hover{background:#eef4ff;border-color:#abc5ec;color:#285fa9}
      .desktop-library-ui .desktop-menu>summary:focus-visible,.desktop-library-ui button:focus-visible,.desktop-library-ui a:focus-visible{outline:2px solid #78a0e6;outline-offset:3px}
      .desktop-library-ui .desktop-popover{position:absolute;top:calc(100% + 8px);right:0;width:320px;max-width:calc(100vw - 32px);padding:16px;background:#fff;border:1px solid #e0e8f2;border-radius:14px;box-shadow:0 14px 40px rgba(43,65,95,.14);z-index:35}
      .desktop-library-ui .desktop-popover h2{font-size:14px;color:#30445e;margin:0 0 13px}
      .desktop-library-ui .desktop-filter-fields{display:grid;gap:13px}
      .desktop-library-ui .desktop-filter-fields label{display:grid;gap:5px;font-size:12px;color:#7a899c}
      .desktop-library-ui .desktop-filter-fields select{width:100%;max-width:none;min-height:39px;font-size:13px}
      .desktop-library-ui .desktop-menu-footer{display:flex;gap:8px;justify-content:flex-end;margin-top:15px;padding-top:12px;border-top:1px solid #edf1f6}
      .desktop-library-ui .desktop-filter-count{background:#e9f1ff;color:#3b6caf;border-radius:5px;padding:0 4px;font-size:11px}
      .desktop-library-ui .desktop-tags-popover{width:430px}
      .desktop-library-ui #tagCloud{margin:0;padding:0;border:0;background:transparent;max-height:260px;overflow:auto;border-radius:0;white-space:normal;flex-wrap:wrap;gap:8px}
      .desktop-library-ui #tagCloud .tag-cloud-label{display:none}
      .desktop-library-ui .tag-chip{font-size:12px;min-height:32px;border-color:#e5eaf2;background:#f8faff}
      .desktop-library-ui .desktop-tags-empty{font-size:12px;color:#8b98aa;margin:0}
      .desktop-library-ui .desktop-active-filters{max-width:1648px;margin:0 auto;padding:0 24px 4px;display:flex;gap:7px;flex-wrap:wrap;align-items:center}
      .desktop-library-ui .desktop-filter-chip{border:0;border-radius:7px;background:#eaf1fc;color:#50729f;font-size:12px;min-height:28px;padding:4px 8px;font-weight:400}
      .desktop-library-ui .desktop-clear-filters{border:0;background:transparent;font-size:12px;color:#8b98aa;min-height:28px;padding:4px 6px;font-weight:400}
      .desktop-library-ui .desktop-page-popover{width:300px}
      .desktop-library-ui .desktop-page-help{font-size:12px;color:#8a96a7;margin:0 0 10px}
      .desktop-library-ui .desktop-page-popover .page-jump{display:flex;justify-content:space-between;gap:6px;font-size:12px}
      .desktop-library-ui .desktop-page-popover .page-jump input{width:68px;min-height:36px}
      .desktop-library-ui .layout{max-width:1648px;padding:9px 24px 24px}
      .desktop-library-ui .toolbar{display:none!important}
      .desktop-library-ui .grid{grid-template-columns:repeat(3,minmax(0,1fr));gap:22px 18px}
      .desktop-library-ui .card{background:transparent;border-color:transparent;box-shadow:none;border-radius:12px;transition:border-color .12s}
      .desktop-library-ui .card:hover,.desktop-library-ui .card.active{transform:none;box-shadow:none;border-color:transparent}
      .desktop-library-ui .card:hover .card-title{color:#3e73b8}
      .desktop-library-ui .thumb{border-radius:12px}
      .desktop-library-ui .card-body{padding:10px 2px 4px}
      .desktop-library-ui .card-title{font-size:14px;font-weight:600;height:42px;line-height:21px}
      .desktop-library-ui .card-author-row{color:#8190a4;font-size:12px;margin-top:4px}
      .desktop-library-ui .card-author-row .card-author{font-weight:400;color:#8190a4}
      .desktop-library-ui .card .badge,.desktop-library-ui .card[data-unplayed=true] .watch-badge{display:none}
      .desktop-library-ui .card[data-has-progress=false] .card-progress{visibility:hidden}
      .desktop-library-ui .card.selected{border-color:#6a94d7;box-shadow:0 0 0 2px rgba(77,131,230,.13)}
      .desktop-library-ui #selectionModeToggle{display:inline-flex!important;align-items:center;justify-content:center;min-height:36px;font-size:12px;line-height:1.25;padding:7px 10px}
      .desktop-library-ui.selection-mode .card-select{display:block!important}
      .desktop-library-ui .desktop-selection-bar{position:fixed;bottom:16px;left:50%;transform:translateX(-50%);width:min(780px,calc(100% - 48px));z-index:40;background:#fff;border:1px solid #dce6f2;border-radius:14px;box-shadow:0 10px 35px rgba(43,65,95,.16);padding:12px 16px}
      .desktop-library-ui .desktop-selection-bar .selection-controls{display:flex!important;gap:9px;align-items:center;flex-wrap:wrap}
      .desktop-library-ui .desktop-selection-bar button{min-height:36px;font-size:12px;padding:7px 12px;white-space:nowrap}
      .desktop-library-ui .desktop-selection-bar #downloadSelected{background:#4d83e6;color:#fff;border-color:#4d83e6}
      .desktop-library-ui .desktop-selection-bar #downloadSelected:disabled{background:#e9eef7;border-color:#e9eef7;color:#8b98aa;cursor:default}
      .desktop-library-ui .desktop-selection-bar .selection-count{margin-left:auto;font-size:12px}
      .desktop-library-ui.selection-mode{padding-bottom:95px}
      .desktop-library-ui .status{margin-top:13px;color:#8b98aa}
      .desktop-library-ui .desktop-library-only{display:block}
      .desktop-library-ui .desktop-library-bar,.desktop-library-ui .desktop-active-filters{display:flex}
      .desktop-library-ui .desktop-library-only[hidden]{display:none!important}
      .desktop-library-ui .desktop-library-tools [hidden],.desktop-library-ui .desktop-popover [hidden]{display:none!important}
      @media(min-width:1100px){.desktop-library-ui .grid{grid-template-columns:repeat(4,minmax(0,1fr))}}
      @media(min-width:1280px){.desktop-library-ui .grid{grid-template-columns:repeat(5,minmax(0,1fr))}}
      @media(min-width:1600px){.desktop-library-ui .grid{grid-template-columns:repeat(6,minmax(0,1fr))}}
      @media(max-width:799px){.desktop-library-ui .grid{grid-template-columns:repeat(2,minmax(0,1fr))}.desktop-library-ui .desktop-nav-inner{gap:12px}.desktop-library-ui header h1{font-size:18px}.desktop-library-ui .desktop-nav-actions{gap:6px}.desktop-library-ui #qualityToggle,.desktop-library-ui #ledgerLink button{padding:7px 8px;font-size:12px}.desktop-library-ui .desktop-library-total{display:none}}
    }
  `;
  document.head.append(style);
  const top = document.createElement('div');
  top.className = 'desktop-nav-inner desktop-library-only';
  const search = document.createElement('div');
  search.className = 'desktop-search';
  search.innerHTML = '<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="10.5" cy="10.5" r="6.5" fill="none" stroke="currentColor" stroke-width="1.8"/><path d="m16 16 4.5 4.5" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/></svg><button class="desktop-search-clear" type="button" aria-label="清除搜索" title="清除搜索" hidden>×</button>';
  const actions = document.createElement('div');
  actions.className = 'desktop-nav-actions';
  const bar = document.createElement('div');
  bar.className = 'desktop-library-bar desktop-library-only';
  bar.innerHTML = '<nav class="desktop-library-tabs" aria-label="视频库导航"><a id="desktopLibraryLink">视频库</a><a id="desktopRecommendLink">随机推荐</a></nav><span id="desktopLibraryTotal" class="desktop-library-total"></span><div class="desktop-library-tools"><button id="desktopNextBatch" type="button" hidden>换一批</button><select id="desktopSort" aria-label="视频排序"></select><details class="desktop-menu" id="desktopFilterMenu"><summary aria-controls="desktopFilterPanel">筛选 <span id="desktopFilterCount" class="desktop-filter-count" hidden></span></summary><div id="desktopFilterPanel" class="desktop-popover"><h2>筛选视频</h2><div class="desktop-filter-fields"></div><div class="desktop-menu-footer"><button id="desktopResetFilters" type="button">重置筛选</button><button id="desktopCloseFilters" type="button">完成</button></div></div></details><details class="desktop-menu" id="desktopTagsMenu"><summary>标签</summary><div class="desktop-popover desktop-tags-popover"><h2>按标签浏览</h2><p id="desktopTagsEmpty" class="desktop-tags-empty">暂无已同步标签，可以在搜索栏输入标签查找。</p></div></details><details class="desktop-menu" id="desktopPageMenu"><summary id="desktopPageSummary">页码</summary><div class="desktop-popover desktop-page-popover"><p id="desktopPageHelp" class="desktop-page-help"></p><div id="desktopJumpHost"></div><div class="desktop-menu-footer"><button id="desktopPreviousPage" type="button">上一页</button><button id="desktopNextPage" type="button">下一页</button></div></div></details></div>';
  const quality = document.createElement('details');
  quality.className = 'desktop-menu';
  quality.id = 'desktopQualityMenu';
  quality.innerHTML = '<summary id="desktopQualitySummary" title="选择播放画质"></summary><div class="desktop-popover" style="width:220px"><h2>播放画质</h2><div class="desktop-filter-fields"><button type="button" data-desktop-profile="local" aria-pressed="false">原画 · 本地 / 局域网</button><button type="button" data-desktop-profile="remote" aria-pressed="false">480p · 远程省流</button></div></div>';
  // This summary is an independent desktop control; the mobile quality button
  // retains its original click-to-toggle handler and text.
  actions.append(quality);
  const filters = document.createElement('div');
  filters.className = 'desktop-active-filters desktop-library-only';
  filters.hidden = true;
  const selectionBar = document.createElement('div');
  selectionBar.className = 'desktop-selection-bar desktop-library-only';
  selectionBar.hidden = true;
  selectionBar.setAttribute('aria-label', '批量下载操作');
  header.append(top);
  header.after(bar, filters);
  document.body.append(selectionBar);
  const sortChoices = [
    ['updatedAt:desc','最近下载'], ['updatedAt:asc','最早下载'],
    ['uploadTime:desc','最新上传'], ['uploadTime:asc','最早上传'],
    ['views:desc','播放量：高 → 低'], ['views:asc','播放量：低 → 高'],
    ['title:asc','标题：A → Z'], ['title:desc','标题：Z → A'],
    ['author:asc','作者：A → Z'], ['author:desc','作者：Z → A']
  ];
  for (const [value, text] of sortChoices) $('desktopSort').add(new Option(text, value));
  const fields = new Map();
  for (const [id, label] of [['authorFilter','作者'],['watchedFilter','观看状态'],['libraryFilter','我的列表']]) {
    const field = document.createElement('label');
    const caption = document.createElement('span');
    caption.textContent = label;
    field.append(caption);
    $('desktopFilterPanel').querySelector('.desktop-filter-fields').append(field);
    fields.set(id, field);
  }
  function move(node, parent) {
    if (!node) return;
    if (!slots.has(node)) {
      const slot = document.createComment('desktop library slot');
      node.before(slot);
      slots.set(node, slot);
    }
    parent.append(node);
  }
  const menus = [quality, ...bar.querySelectorAll('details')];
  function closeMenus(except = null) {
    for (const menu of menus) if (menu !== except) menu.open = false;
  }
  for (const menu of menus) {
    menu.querySelector('summary').setAttribute('aria-expanded', 'false');
    menu.addEventListener('toggle', () => {
      menu.querySelector('summary').setAttribute('aria-expanded', String(menu.open));
      if (menu.open) closeMenus(menu);
    });
  }
  document.addEventListener('click', event => {
    if (active && !event.target.closest('.desktop-menu')) closeMenus();
  });
  document.addEventListener('keydown', event => {
    if (!active || event.key !== 'Escape') return;
    const open = menus.find(menu => menu.open);
    if (open) { closeMenus(); open.querySelector('summary').focus(); }
  });
  function browseUrl(path, preserveScope = false) {
    const url = new URL(path, location.origin);
    url.searchParams.set('profile', playbackProfile);
    if (preserveScope) {
      for (const [key, value] of Object.entries({query:$('query').value.trim(),sort:$('sort').value,direction:$('direction').value,watched:$('watchedFilter').value,library:$('libraryFilter').value})) {
        if (value) url.searchParams.set(key, value);
      }
    }
    try { const token = sessionStorage.getItem('iwaraAccessToken'); if (token) url.searchParams.set('access_token', token); } catch {}
    return url.pathname + url.search;
  }
  function resetField(id) {
    if (id === 'query') { $('query').value = ''; $('authorFilter').value = 'all'; }
    else {
      const old = $(id).value;
      $(id).value = 'all';
      if (id === 'authorFilter' && $('query').value.trim() === old) $('query').value = '';
    }
    _updateMobileFilterSummary();
    update();
    void load(true);
  }
  function conditionChip(id, text) {
    const chip = document.createElement('button');
    chip.type = 'button';
    chip.className = 'desktop-filter-chip';
    chip.textContent = text + ' ×';
    chip.title = '取消条件：' + text;
    chip.onclick = () => resetField(id);
    filters.append(chip);
  }
  function update() {
    if (!active) return;
    $('pageTitle').textContent = 'Iwara 视频库';
    const local = playbackProfile !== 'remote';
    $('desktopQualitySummary').textContent = local ? '原画' : '远程 480p';
    quality.querySelectorAll('[data-desktop-profile]').forEach(button => {
      const selected = button.dataset.desktopProfile === playbackProfile;
      button.setAttribute('aria-pressed', String(selected));
      button.style.color = selected ? '#326cba' : '';
      button.style.background = selected ? '#edf4ff' : '';
    });
    $('desktopLibraryLink').href = browseUrl('/playlist');
    $('desktopRecommendLink').href = browseUrl('/recommend', true);
    $('desktopLibraryLink').setAttribute('aria-current', recommendationMode ? 'false' : 'page');
    $('desktopRecommendLink').setAttribute('aria-current', recommendationMode ? 'page' : 'false');
    $('desktopLibraryTotal').textContent = recommendationMode ? '本批 ' + items.length + ' 条' : '共 ' + Number(totalItems || 0).toLocaleString('zh-CN') + ' 条';
    $('desktopLibraryTotal').title = '已加载 ' + items.length + ' 条本地视频';
    $('desktopNextBatch').hidden = !recommendationMode;
    $('desktopSort').value = $('sort').value + ':' + $('direction').value;
    $('desktopSort').disabled = $('libraryFilter').value === 'queued';
    $('desktopSort').title = $('desktopSort').disabled ? '播放队列使用加入队列的顺序' : '选择排列方式';
    const max = Math.max(1, Math.ceil(totalItems / 30));
    const currentPage = Math.min(pageNo, max);
    $('desktopPageMenu').hidden = recommendationMode || !totalItems;
    $('desktopPageSummary').textContent = currentPage + ' / ' + max + ' 页';
    $('desktopPageSummary').title = '跳转页码';
    $('desktopPageHelp').textContent = '共 ' + max + ' 页，每批 30 条；向下滚动会自动加载。';
    $('desktopPreviousPage').disabled = currentPage <= 1;
    $('desktopNextPage').disabled = currentPage >= max;
    $('pageJumpControls').hidden = recommendationMode;
    if (document.activeElement !== $('pageInput')) $('pageInput').value = String(currentPage);
    $('desktopTagsEmpty').hidden = popularTags.length > 0;
    $('selectionModeToggle').textContent = document.body.classList.contains('selection-mode') ? '取消选择' : '批量选择';
    selectionBar.hidden = !document.body.classList.contains('selection-mode');
    search.querySelector('button').hidden = !$('query').value;
    filters.replaceChildren();
    const author = $('authorFilter').value;
    const query = $('query').value.trim();
    if (author !== 'all') conditionChip('authorFilter', '作者：' + ($('authorFilter').selectedOptions[0]?.textContent || author).split(' · ')[0]);
    if (query && (author === 'all' || query !== author)) conditionChip('query', (popularTags.some(item => item.tag === query) ? '标签：' : '搜索：') + query);
    for (const [id, label] of [['watchedFilter','观看'], ['libraryFilter','列表']]) {
      if ($(id).value !== 'all') conditionChip(id, label + '：' + $(id).selectedOptions[0].textContent);
    }
    filters.hidden = !filters.children.length;
    if (filters.children.length) {
      const clear = document.createElement('button');
      clear.className = 'desktop-clear-filters';
      clear.type = 'button';
      clear.textContent = '清除全部';
      clear.onclick = () => { $('query').value = ''; for (const id of fields.keys()) $(id).value = 'all'; _updateMobileFilterSummary(); update(); void load(true); };
      filters.append(clear);
    }
    const filterCount = [...fields.keys()].filter(id => $(id).value !== 'all').length;
    $('desktopFilterCount').hidden = !filterCount;
    $('desktopFilterCount').textContent = String(filterCount);
    document.querySelectorAll('.card').forEach((node, index) => {
      const task = items[index];
      const progress = progressInfo(task || {});
      node.dataset.unplayed = String(!task?.watched && progress.position <= 1);
      node.dataset.hasProgress = String(progress.position > 1 && progress.duration > 0);
    });
  }
  function applyBreakpoint() {
    if (desktop.matches === active) return;
    active = desktop.matches;
    document.body.classList.toggle('desktop-library-ui', active);
    if (active) {
      move(header.querySelector('h1'), top);
      top.append(search, actions);
      move($('query'), search);
      search.querySelector('button').before($('query'));
      move($('ledgerLink'), actions);
      for (const [id, field] of fields) move($(id), field);
      move($('selectionModeToggle'), bar.querySelector('.desktop-library-tools'));
      $('desktopPageMenu').before($('selectionModeToggle'));
      move($('pageJumpControls'), $('desktopJumpHost'));
      move($('tagCloud'), $('desktopTagsMenu').querySelector('.desktop-popover'));
      move(document.querySelector('.selection-controls'), selectionBar);
      $('query').placeholder = '搜索视频、作者、标签…';
      update();
    } else {
      closeMenus();
      for (const [node, slot] of slots) slot.replaceWith(node);
      slots.clear();
      $('pageTitle').textContent = originalTitle;
      $('query').placeholder = originalPlaceholder;
      $('selectionModeToggle').textContent = document.body.classList.contains('selection-mode') ? '取消选择' : '批量下载';
      selectionBar.hidden = true;
      _placeMobileControls();
      setPlaybackProfile(playbackProfile);
      render();
    }
  }
  $('desktopSort').onchange = () => {
    const [sort, direction] = $('desktopSort').value.split(':');
    $('sort').value = sort;
    $('direction').value = direction;
    $('sort').dispatchEvent(new Event('change', {bubbles:true}));
    update();
  };
  search.querySelector('button').onclick = () => resetField('query');
  $('query').addEventListener('input', () => {
    if (active && $('authorFilter').value !== 'all' && $('query').value.trim() !== $('authorFilter').value) {
      $('authorFilter').value = 'all';
      _updateMobileFilterSummary();
    }
    update();
  });
  $('tagCloud').addEventListener('click', event => {
    if (!active || !event.target.closest('[data-tag]')) return;
    $('authorFilter').value = 'all';
    closeMenus();
  }, true);
  for (const id of fields.keys()) $(id).addEventListener('change', update);
  $('desktopResetFilters').onclick = () => { for (const id of fields.keys()) { const old = $(id).value; $(id).value = 'all'; if (id === 'authorFilter' && $('query').value.trim() === old) $('query').value = ''; } _updateMobileFilterSummary(); update(); void load(true); };
  $('desktopCloseFilters').onclick = () => closeMenus();
  $('desktopNextBatch').onclick = () => { closeMenus(); $('refresh').click(); };
  $('desktopPreviousPage').onclick = () => { closeMenus(); window.__iwaraSetPage(Math.max(1, pageNo - 1)); window.scrollTo(0, 0); };
  $('desktopNextPage').onclick = () => { closeMenus(); window.__iwaraSetPage(Math.min(Math.ceil(totalItems / 30), pageNo + 1)); window.scrollTo(0, 0); };
  quality.querySelectorAll('[data-desktop-profile]').forEach(button => button.onclick = () => {
    closeMenus();
    const profile = button.dataset.desktopProfile;
    if (profile === playbackProfile) return;
    const url = new URL(location.href);
    url.searchParams.set('profile', profile);
    try { const token = sessionStorage.getItem('iwaraAccessToken'); if (token) url.searchParams.set('access_token', token); } catch {}
    location.href = url.pathname + url.search;
  });
  window.addEventListener('iwara-page-jump', () => { if (active) { closeMenus(); window.scrollTo(0, 0); } });
  $('grid').addEventListener('click', event => {
    if (!active || !document.body.classList.contains('selection-mode') || event.target.closest('input')) return;
    const card = event.target.closest('.card');
    const checkbox = card?.querySelector('.card-select');
    if (!checkbox) return;
    event.preventDefault();
    event.stopPropagation();
    checkbox.checked = !checkbox.checked;
    checkbox.dispatchEvent(new Event('change', {bubbles:true}));
  }, true);
  const baseRender = render;
  render = (...args) => { const result = baseRender(...args); update(); return result; };
  const baseSelectionUpdate = updateSelectionUi;
  updateSelectionUi = (...args) => { const result = baseSelectionUpdate(...args); update(); return result; };
  const baseProfileUpdate = setPlaybackProfile;
  setPlaybackProfile = (...args) => { const result = baseProfileUpdate(...args); update(); return result; };
  const baseTagRender = renderTagCloud;
  renderTagCloud = (...args) => { const result = baseTagRender(...args); update(); return result; };
  if (desktop.addEventListener) desktop.addEventListener('change', applyBreakpoint);
  else desktop.addListener(applyBreakpoint);
  applyBreakpoint();
}
