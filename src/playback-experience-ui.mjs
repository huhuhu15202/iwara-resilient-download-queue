// Progressive UI enhancement. Native media controls and download handlers stay
// in server.mjs; sheets use draft controls and commit once on Apply.
export function playbackExperienceScript() {
  return `(${enhancePlaybackExperience.toString()})();`;
}

function enhancePlaybackExperience() {
  const mobile = matchMedia('(max-width:600px)');
  const style = document.createElement('style');
  style.textContent = `
    .experience-sheet{position:fixed;inset:auto 0 0;margin:0 auto;width:min(520px,100%);max-height:82dvh;padding:0;border:1px solid #dde6f1;border-radius:22px 22px 0 0;background:#fff;color:#30445e;box-shadow:0 -12px 50px #24395525;overflow:hidden}
    .experience-sheet::backdrop{background:rgba(18,30,49,.4)}
    .experience-sheet[open]{display:flex;flex-direction:column}
    .experience-sheet-head{display:flex;align-items:center;gap:10px;padding:14px 16px 8px;flex:none}
    .experience-sheet-head h2{font-size:17px;margin:0;flex:1}
    .experience-sheet-head button{width:44px;min-height:44px;padding:0;background:transparent;border:0;font-size:23px;font-weight:400;color:#7c8ca0}
    .experience-sheet-body{overflow:auto;overscroll-behavior:contain;min-height:0;padding:6px 16px 16px}
    .experience-sheet-body label{display:grid;gap:7px;margin-top:14px;font-size:12px;color:#71829a}
    .experience-sheet-body select{width:100%;min-width:0;min-height:44px;color:#30445e;font-size:14px}
    .experience-sheet-foot{display:flex;gap:10px;padding:12px 16px calc(12px + env(safe-area-inset-bottom,0px));border-top:1px solid #edf1f6;flex:none}
    .experience-sheet-foot button{min-height:44px;flex:1}
    .experience-sheet-foot .sheet-apply{background:#4d83e6;border-color:#4d83e6;color:#fff}
    .experience-sheet-hint{margin:3px 0 0;color:#8a98aa;font-size:12px}
    .experience-choices{display:grid;gap:8px}
    .experience-choices button{display:flex;align-items:center;gap:10px;text-align:left;min-height:58px;padding:10px 13px;border-radius:12px;font-weight:500}
    .experience-choices button>span{display:grid;gap:3px;flex:1}
    .experience-choices small{color:#8190a3;font-size:12px;font-weight:400}
    .experience-choices button[aria-pressed=true]{background:#edf4ff;border-color:#8db0e5;color:#326cba}
    .experience-choices button[aria-pressed=true]::after{content:'✓';font-size:18px}
    .player-info-details{margin:8px 0 0;color:#71829a;font-size:12px}
    .player-info-details>summary{cursor:pointer;display:inline-flex;align-items:center;min-height:36px;gap:6px;list-style:none}
    .player-info-details>summary::-webkit-details-marker{display:none}
    .player-info-details>summary::after{content:'⌄'}
    .player-info-details[open]>summary::after{content:'⌃'}
    .player-info-details>div{display:grid;gap:7px;padding:7px 0 3px;overflow-wrap:anywhere}
    .player-info-details span{white-space:normal}
    .experience-mobile-nav{display:none}
    @media(min-width:601px){.experience-sheet{inset:50% auto auto 50%;transform:translate(-50%,-50%);margin:0;max-height:80vh;border-radius:18px}.experience-sheet-foot{padding-bottom:12px}}
    @media(max-width:600px){
      body.mobile-library-experience header{min-height:54px;padding:5px 12px;gap:7px}
      .mobile-library-experience header h1{font-size:18px}
      .mobile-library-experience header #qualityToggle{min-height:44px;max-width:none;padding:6px 10px;font-size:12px;border:0;background:#eaf1fc;border-radius:999px}
      .mobile-library-experience header #recommendLink{display:none!important}
      .mobile-library-experience #mobileSearchBar{display:grid;grid-template-columns:minmax(0,1fr) 54px;gap:7px;position:relative;padding:5px 12px 7px}
      .mobile-library-experience #mobileSearchBar input{grid-column:1;grid-row:1;min-height:44px;padding-right:46px;font-size:14px;background:#fff}
      .mobile-library-experience .mobile-search-filter{grid-column:2;grid-row:1;min-height:44px;padding:0 4px;font-size:13px;border:0;background:#e9eff8;border-radius:12px}
      .mobile-library-experience .mobile-search-filter.active{background:#deebff;color:#326cba}
      .mobile-library-experience .mobile-search-clear{position:absolute;right:72px;top:5px;min-height:44px;width:44px;padding:0;border:0;background:transparent;font-size:19px;font-weight:400;color:#8a98aa}
      .mobile-library-experience .mobile-search-clear[hidden]{display:none}
      .mobile-library-experience #mobileAppBar{display:block;padding:0 12px;border-bottom:1px solid #e5ebf3;background:transparent}
      .mobile-library-experience #mobileAppBar>button,.mobile-library-experience #mobileFilterPanel{display:none!important}
      .mobile-library-experience .experience-mobile-nav{display:flex;align-items:center;gap:18px;min-height:44px}
      .experience-mobile-nav a{display:flex;align-items:center;justify-content:center;min-height:44px;text-decoration:none;color:#7c8ba0;font-size:14px;border-bottom:2px solid transparent;white-space:nowrap}
      .experience-mobile-nav a[aria-current=page]{font-weight:650;color:#326cba;border-bottom-color:#4d83e6}
      .experience-mobile-nav #selectionModeToggle,.experience-mobile-nav #mobileNewBatch{display:inline-flex!important;min-height:44px;align-items:center;justify-content:center;font-size:12px;padding:6px 8px;border:0;background:transparent;white-space:nowrap}
      .experience-mobile-nav #selectionModeToggle{margin-left:auto;color:#627791}
      .experience-mobile-nav #selectionModeToggle[aria-pressed=true]{color:#326cba;background:#eaf1fc}
      .experience-mobile-nav #mobileNewBatch[hidden]{display:none!important}
      .mobile-library-experience #mobileFilterSummary{display:block;font-size:11px;padding:2px 0 7px}
      .mobile-library-experience #mobileFilterSummary[hidden]{display:none}
      .mobile-library-experience .toolbar{grid-template-columns:minmax(0,1fr) auto;gap:6px;margin:0 0 8px}
      .mobile-library-experience .toolbar .count{grid-column:1;grid-row:1;text-align:left;font-size:11px;color:#8997aa}
      .mobile-library-experience .toolbar #mobilePageToggle{grid-column:2;min-height:44px;padding:5px 7px;border:0;background:transparent;color:#7c8ba0}
      .mobile-library-experience .layout{padding:8px 12px 18px}
      .mobile-library-experience .card{border-radius:12px;box-shadow:none}
      .mobile-library-experience .card:hover{transform:none}
      .mobile-library-experience .card-body{padding:8px}
      .mobile-library-experience .card-title{font-size:14px;line-height:20px;height:40px;font-weight:600}
      .mobile-library-experience .card-author-row{font-size:11px;height:18px;line-height:18px}
      .mobile-library-experience .card .badge,.mobile-library-experience .card[data-unplayed=true] .watch-badge{display:none}
      .mobile-library-experience .card[data-has-progress=false] .card-progress{visibility:hidden}
      .mobile-library-experience .card .watch-badge{font-size:10px;padding:2px 5px}
      .single-mode #mainMeta{font-size:12px;gap:6px 10px}
      .single-mode .player-info-details>summary{min-height:44px}
    }
    @media(prefers-color-scheme:dark) and (max-width:600px){
      .experience-sheet{background:#20242b;color:#d8e6ff;border-color:#3d4654}
      .experience-sheet-body select,.experience-choices button{background:#15191f;color:#d8e6ff;border-color:#3d4654}
      .experience-sheet-foot{border-color:#3d4654}
      .experience-choices button[aria-pressed=true]{background:#263d5b;border-color:#547cae;color:#d8e6ff}
      .mobile-library-experience header #qualityToggle,.mobile-library-experience .mobile-search-filter{background:#273345;color:#c5d7ee}
      .mobile-library-experience .mobile-search-filter.active{background:#314866;color:#b2cef5}
      .mobile-library-experience #mobileSearchBar input{background:#15191f;color:#d8e6ff}
      .mobile-library-experience #mobileAppBar{border-color:#303844}
      .experience-mobile-nav a[aria-current=page]{color:#9ebff1}
      .experience-mobile-nav #selectionModeToggle[aria-pressed=true]{background:#263d5b;color:#b2cef5}
    }
  `;
  document.head.append(style);
  let openSheetCount = 0;
  let previousOverflow = '';
  function makeSheet(id, title) {
    const dialog = document.createElement('dialog');
    dialog.id = id;
    dialog.className = 'experience-sheet';
    dialog.setAttribute('aria-labelledby', id + 'Title');
    dialog.innerHTML = '<div class="experience-sheet-head"><h2 id="' + id + 'Title"></h2><button type="button" aria-label="关闭' + title + '">×</button></div><div class="experience-sheet-body"></div>';
    dialog.querySelector('h2').textContent = title;
    document.body.append(dialog);
    let opener = null;
    function close() { if (dialog.open) dialog.close(); }
    dialog.querySelector('button').onclick = close;
    dialog.addEventListener('click', event => {
      const rect = dialog.getBoundingClientRect();
      if (event.target === dialog && (event.clientY < rect.top || event.clientY > rect.bottom || event.clientX < rect.left || event.clientX > rect.right)) close();
    });
    dialog.addEventListener('close', () => {
      openSheetCount = Math.max(0, openSheetCount - 1);
      if (!openSheetCount) document.body.style.overflow = previousOverflow;
      if (opener?.isConnected) opener.focus({preventScroll:true});
    });
    return {dialog,body:dialog.querySelector('.experience-sheet-body'),close,open:() => {
      if (dialog.open) return;
      opener = document.activeElement;
      if (!openSheetCount) previousOverflow = document.body.style.overflow;
      openSheetCount++;
      document.body.style.overflow = 'hidden';
      dialog.showModal();
    }};
  }

  const modeSheet = makeSheet('playbackModeSheet', '播放模式');
  modeSheet.body.classList.add('experience-choices');
  for (const [mode, value] of Object.entries(playbackModes)) {
    const button = document.createElement('button');
    button.type = 'button';
    button.dataset.mode = mode;
    const title = document.createElement('span');
    title.textContent = value.label;
    const help = document.createElement('small');
    help.textContent = value.title;
    title.append(help);
    button.append(title);
    button.onclick = () => { setPlaybackMode(mode); modeSheet.close(); };
    modeSheet.body.append(button);
  }
  const originalModeUpdate = updatePlaybackModeButton;
  updatePlaybackModeButton = (...args) => {
    originalModeUpdate(...args);
    modeSheet.body.querySelectorAll('[data-mode]').forEach(button => button.setAttribute('aria-pressed', String(button.dataset.mode === playbackMode)));
  };
  updatePlaybackModeButton();
  $('playModeToggle').title = '选择播放模式';
  $('playModeToggle').setAttribute('aria-haspopup','dialog');
  $('playModeToggle').setAttribute('aria-controls','playbackModeSheet');
  $('playModeToggle').onclick = () => { updatePlaybackModeButton(); modeSheet.open(); };

  const metaDetails = document.createElement('details');
  metaDetails.id = 'playerInfoDetails';
  metaDetails.className = 'player-info-details';
  metaDetails.hidden = true;
  metaDetails.innerHTML = '<summary>视频信息</summary><div></div>';
  $('mainMeta').after(metaDetails);
  let metaTaskId = '';
  const baseSelect = select;
  select = (...args) => {
    const result = baseSelect(...args);
    const task = items[current];
    if (!task) return result;
    const extra = [...$('mainMeta').children].slice(2);
    metaDetails.querySelector('div').replaceChildren(...extra);
    metaDetails.hidden = !extra.length;
    if (metaTaskId !== task.id) metaDetails.open = false;
    metaTaskId = task.id;
    return result;
  };
  const baseMetaRender = render;
  render = (...args) => {
    const result = baseMetaRender(...args);
    if (singleVideoMode && !items[current]) { metaDetails.hidden = true; metaDetails.open = false; }
    return result;
  };
  if (singleVideoMode) return;

  const filterSheet = makeSheet('mobileFilterSheet', '筛选与排序');
  const hint = document.createElement('p');
  hint.className = 'experience-sheet-hint';
  hint.textContent = '选好条件后点“应用”，列表只更新一次。';
  filterSheet.body.append(hint);
  const drafts = new Map();
  for (const [id, label] of [['authorFilter','作者'],['sort','排序'],['watchedFilter','观看状态'],['libraryFilter','我的列表']]) {
    const field = document.createElement('label');
    field.textContent = label;
    const control = document.createElement('select');
    control.id = 'draft-' + id;
    control.setAttribute('aria-label', label);
    field.append(control);
    filterSheet.body.append(field);
    drafts.set(id, control);
  }
  for (const [value, label] of [['updatedAt:desc','最近下载'],['updatedAt:asc','最早下载'],['uploadTime:desc','最新上传'],['uploadTime:asc','最早上传'],['views:desc','播放量：高 → 低'],['views:asc','播放量：低 → 高'],['title:asc','标题：A → Z'],['title:desc','标题：Z → A'],['author:asc','作者：A → Z'],['author:desc','作者：Z → A']]) {
    drafts.get('sort').add(new Option(label,value));
  }
  const footer = document.createElement('div');
  footer.className = 'experience-sheet-foot';
  footer.innerHTML = '<button id="resetMobileDraft" type="button">重置</button><button id="applyMobileDraft" class="sheet-apply" type="button">应用</button>';
  filterSheet.dialog.append(footer);
  let clearQuery = false;
  let application = 0;
  function syncDrafts() {
    for (const [id, control] of drafts) {
      if (id === 'sort') control.value = $('sort').value + ':' + $('direction').value;
      else { control.replaceChildren(...[...$(id).options].map(option => option.cloneNode(true))); control.value = $(id).value || 'all'; }
    }
    drafts.get('sort').disabled = drafts.get('libraryFilter').value === 'queued';
    clearQuery = false;
  }
  drafts.get('libraryFilter').onchange = () => { drafts.get('sort').disabled = drafts.get('libraryFilter').value === 'queued'; };
  $('resetMobileDraft').onclick = () => {
    for (const [id, control] of drafts) control.value = id === 'sort' ? 'updatedAt:desc' : 'all';
    drafts.get('sort').disabled = false;
    clearQuery = true;
  };
  $('applyMobileDraft').onclick = async () => {
    const thisApplication = ++application;
    const button = $('applyMobileDraft');
    button.disabled = true;
    try {
      for (let wait = 0; loading; wait++) {
        await new Promise(resolve => setTimeout(resolve,100));
        if (!filterSheet.dialog.open || thisApplication !== application) return;
        if (wait > 100) { hint.textContent = '当前列表仍在加载，请稍后再应用。'; return; }
      }
      const oldAuthor = $('authorFilter').value;
      const newAuthor = drafts.get('authorFilter').value;
      if (clearQuery) $('query').value = '';
      if (newAuthor !== oldAuthor) {
        if (newAuthor !== 'all') $('query').value = newAuthor;
        else if ($('query').value.trim() === oldAuthor) $('query').value = '';
      }
      const [sort,direction] = drafts.get('sort').value.split(':');
      $('sort').value = sort;
      $('direction').value = direction;
      for (const [id,control] of drafts) if (id !== 'sort') $(id).value = control.value;
      _updateMobileFilterSummary();
      filterSheet.close();
      window.scrollTo(0,0);
      void load(true);
      updateMobile();
    } finally { button.disabled = false; }
  };
  filterSheet.dialog.addEventListener('close', () => { application++; });
  const filterButton = document.createElement('button');
  filterButton.type = 'button';
  filterButton.id = 'mobileSearchFilter';
  filterButton.className = 'mobile-search-filter';
  filterButton.textContent = '筛选';
  filterButton.setAttribute('aria-controls', 'mobileFilterSheet');
  filterButton.setAttribute('aria-haspopup','dialog');
  filterButton.setAttribute('aria-expanded','false');
  filterButton.onclick = () => { syncDrafts(); hint.textContent = '选好条件后点“应用”，列表只更新一次。'; filterSheet.open(); filterButton.setAttribute('aria-expanded','true'); };
  filterSheet.dialog.addEventListener('close', () => filterButton.setAttribute('aria-expanded','false'));
  filterSheet.dialog.addEventListener('toggle', () => filterButton.setAttribute('aria-expanded',String(filterSheet.dialog.open)));
  const clearSearch = document.createElement('button');
  clearSearch.type = 'button';
  clearSearch.className = 'mobile-search-clear';
  clearSearch.setAttribute('aria-label','清除搜索');
  clearSearch.textContent = '×';
  clearSearch.hidden = true;
  clearSearch.onclick = () => { $('query').value = ''; $('authorFilter').value = 'all'; _updateMobileFilterSummary(); updateMobile(); void load(true); };
  $('mobileSearchBar').append(filterButton,clearSearch);
  const nav = document.createElement('nav');
  nav.className = 'experience-mobile-nav';
  nav.setAttribute('aria-label','视频库导航');
  nav.innerHTML = '<a id="mobileLibraryTab">视频库</a><a id="mobileRecommendTab">推荐</a><button id="mobileNewBatch" type="button" hidden>换一批</button>';
  $('mobileAppBar').prepend(nav);
  $('mobileNewBatch').onclick = () => $('refresh').click();
  function scopeUrl(path) {
    const url = new URL(path,location.origin);
    const scope = playlistScope();
    for (const [key,value] of Object.entries({query:scope.query,sort:$('sort').value,direction:scope.direction,watched:scope.watched,library:scope.library,profile:playbackProfile})) {
      if (value && value !== 'all') url.searchParams.set(key,value);
    }
    try { const token = sessionStorage.getItem('iwaraAccessToken'); if (token) url.searchParams.set('access_token',token); } catch {}
    return url.pathname + url.search;
  }
  let selectionSlot = null;
  let active = false;
  const originalPlaceholder = $('query').placeholder;
  function updateMobile() {
    if (!active) return;
    $('pageTitle').textContent = 'Iwara 视频库';
    $('mobileLibraryTab').href = scopeUrl('/playlist');
    $('mobileRecommendTab').href = scopeUrl('/recommend');
    $('mobileLibraryTab').setAttribute('aria-current', recommendationMode ? 'false' : 'page');
    $('mobileRecommendTab').setAttribute('aria-current', recommendationMode ? 'page' : 'false');
    $('mobileNewBatch').hidden = !recommendationMode;
    $('selectionModeToggle').textContent = document.body.classList.contains('selection-mode') ? '取消' : '选择';
    $('selectionModeToggle').title = '选择多个视频，批量下载';
    clearSearch.hidden = !$('query').value;
    const author = $('authorFilter').value, query = $('query').value.trim(), summary = [];
    if (author !== 'all') summary.push('作者：' + ($('authorFilter').selectedOptions[0]?.textContent || author).split(' · ')[0]);
    if (query && (author === 'all' || query !== author)) summary.push((popularTags.some(item => item.tag === query) ? '标签：' : '搜索：') + query);
    for (const id of ['watchedFilter','libraryFilter']) if ($(id).value !== 'all') summary.push($(id).selectedOptions[0].textContent);
    if ($('sort').value !== 'updatedAt' || $('direction').value !== 'desc') {
      const sortLabel = [...drafts.get('sort').options].find(option => option.value === $('sort').value + ':' + $('direction').value)?.textContent;
      if (sortLabel) summary.push(sortLabel);
    }
    $('mobileFilterSummary').textContent = summary.join(' · ');
    $('mobileFilterSummary').hidden = !summary.length;
    filterButton.classList.toggle('active',Boolean(summary.length));
    document.querySelectorAll('#grid .card').forEach((node,index) => {
      const task = items[index];
      const progress = progressInfo(task || {});
      node.dataset.unplayed = String(!task?.watched && progress.position <= 1);
      node.dataset.hasProgress = String(progress.position > 1 && progress.duration > 0);
    });
  }
  function applyMobileBreakpoint() {
    active = mobile.matches;
    document.body.classList.toggle('mobile-library-experience',active);
    const button = $('selectionModeToggle');
    if (active) {
      if (button.parentElement !== nav) { selectionSlot = document.createComment('mobile selection slot'); button.before(selectionSlot); nav.append(button); }
      $('query').placeholder = '搜索视频、作者、标签';
      updateMobile();
    } else {
      filterSheet.close();
      if (button.parentElement === nav && selectionSlot?.isConnected) selectionSlot.replaceWith(button);
      else selectionSlot?.remove();
      selectionSlot = null;
      $('query').placeholder = document.body.classList.contains('desktop-library-ui') ? '搜索视频、作者、标签…' : originalPlaceholder;
    }
  }
  const originalRender = render;
  render = (...args) => { const result = originalRender(...args); updateMobile(); return result; };
  const originalSelectionUpdate = updateSelectionUi;
  updateSelectionUi = (...args) => { const result = originalSelectionUpdate(...args); updateMobile(); return result; };
  $('query').addEventListener('input', () => {
    if (active && $('authorFilter').value !== 'all' && $('query').value.trim() !== $('authorFilter').value) $('authorFilter').value = 'all';
    updateMobile();
  });
  $('grid').addEventListener('click', event => {
    if (!active || !document.body.classList.contains('selection-mode') || event.target.closest('input')) return;
    const box = event.target.closest('.card')?.querySelector('.card-select');
    if (!box) return;
    event.preventDefault();
    event.stopPropagation();
    box.checked = !box.checked;
    box.dispatchEvent(new Event('change',{bubbles:true}));
  },true);
  if (mobile.addEventListener) mobile.addEventListener('change',applyMobileBreakpoint);
  else mobile.addListener(applyMobileBreakpoint);
  applyMobileBreakpoint();
}
