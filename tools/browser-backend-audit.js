async (page) => {
  const results = [];
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  const tinyPng = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wl6f9sAAAAASUVORK5CYII=', 'base64');
  await page.route('**/cover/**', route => route.fulfill({ status: 200, contentType: 'image/png', body: tinyPng }));
  for (const viewport of [{ width: 1440, height: 900 }, { width: 390, height: 844 }]) {
    await page.setViewportSize(viewport);
    await page.goto('http://127.0.0.1:18878/playlist');
    await page.waitForFunction(() => typeof items !== 'undefined' && items.length > 0 && !loading);
    const coverRequests = [];
    const countCover = request => { if (new URL(request.url()).pathname.startsWith('/cover/')) coverRequests.push(new URL(request.url()).pathname); };
    page.on('request', countCover);
    const data = await page.evaluate(async () => {
      loadObserver?.disconnect();
      window.__auditFirst = document.querySelector('#grid .card');
      window.__auditFirstImage = __auditFirst.querySelector('img');
      const initial = items.length;
      const timings = [];
      while (items.length < 400) {
        const started = performance.now();
        await load(false, false, pageNo + 1);
        timings.push(performance.now() - started);
        if (items.length < initial || timings.length > 30) throw Error('append failed');
      }
      const loaded = items.length;
      const reused = __auditFirst === document.querySelector('#grid .card') && __auditFirstImage === __auditFirst.querySelector('img');
      const oldPage = pageNo, oldLength = items.length;
      const actualFetch = window.fetch;
      window.fetch = (input, options) => String(input).startsWith('/playlist-data?') ? Promise.resolve(new Response(JSON.stringify({ error: 'injected failure' }), { status: 503, headers: { 'content-type': 'application/json' } })) : actualFetch(input, options);
      await load(false, false, oldPage + 1);
      const failedPagePreserved = pageNo === oldPage && items.length === oldLength;
      window.fetch = actualFetch;
      await load(false, false, oldPage + 1);
      const retrySamePage = pageNo === oldPage + 1 && new Set(items.map(item => item.id)).size === items.length;
      return { initial, loaded, reused, failedPagePreserved, retrySamePage, appendMaxMs: Math.max(...timings), heapMiB: performance.memory ? performance.memory.usedJSHeapSize / 1024 / 1024 : null };
    });
    await page.locator('#selectionModeToggle').click();
    await page.locator('#grid .card-select').first().check();
    const selected = await page.evaluate(() => selectedIds.size === 1 && __auditFirst.classList.contains('selected'));
    const retainedAfterUpdate = await page.evaluate(async () => {
      await updatePlaylistFlag(items[0].id, { favorite: !items[0].favorite });
      return __auditFirst === document.querySelector('#grid .card') && __auditFirstImage === __auditFirst.querySelector('img');
    });
    const firstId = await page.evaluate(() => items[0].id);
    const repeatedFirstCover = coverRequests.filter(url => url === '/cover/' + firstId).length;
    const before = await page.evaluate(() => { setSelectionMode(false); loadObserver?.disconnect(); window.scrollTo(0, 4500); return { ids: items.map(item => item.id), y: scrollY }; });
    await page.evaluate(() => openStandalone(Math.min(100, items.length - 1)));
    await page.waitForFunction(() => document.body.classList.contains('single-mode') && items.length > 0 && !loading);
    await page.evaluate(() => document.querySelector('#mainVideo').pause());
    await page.locator('#toggleView').click();
    await page.waitForFunction(() => !document.body.classList.contains('single-mode') && items.length >= 400 && !loading);
    const restored = await page.evaluate(before => ({ sameOrder: JSON.stringify(items.map(item => item.id)) === JSON.stringify(before.ids), scrollDifference: Math.abs(scrollY - before.y) }), before);
    const race = await page.evaluate(async () => {
      const original = window.fetch;
      window.fetch = async (input, options) => {
        if (String(input).includes('query=__obsolete')) { const response = await original(input, { ...options, signal: undefined }); await new Promise(resolve => setTimeout(resolve, 300)); return response; }
        return original(input, options);
      };
      $('query').value = '__obsolete'; const old = load(true, false);
      $('query').value = 'dance'; const recent = load(true, false);
      await Promise.all([old, recent]); window.fetch = original;
      return { latestWins: items.length > 0 && totalItems > 100, query: $('query').value };
    });
    page.off('request', countCover);
    if (!data.reused || !data.failedPagePreserved || !data.retrySamePage || !selected || !retainedAfterUpdate || repeatedFirstCover > 1 || !restored.sameOrder || restored.scrollDifference > 5 || !race.latestWins) throw Error(JSON.stringify({ viewport, data, selected, retainedAfterUpdate, repeatedFirstCover, restored, race }));
    results.push({ viewport, ...data, selected, retainedAfterUpdate, repeatedFirstCover, restored, race });
  }
  if (errors.length) throw Error(JSON.stringify(errors));
  return { ok: true, results, pageErrors: errors };
}
