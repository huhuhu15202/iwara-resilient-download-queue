import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { classifyMediaSource } from '../src/media-source.mjs';
import { SQLiteStore } from '../src/sqlite-store.mjs';

test('source classification keeps Han1, Iwara, and unidentified local imports distinct', () => {
  assert.equal(classifyMediaSource({ sourcePlatform: 'han1meview', videoId: 'han1meview-123' }), 'han1');
  assert.equal(classifyMediaSource({ videoId: 'han1meview-456' }), 'han1');
  assert.equal(classifyMediaSource({ sourcePlatform: 'iwara' }), 'iwara');
  assert.equal(classifyMediaSource({ sourcePage: 'https://www.iwara.tv/video/abc123' }), 'iwara');
  assert.equal(classifyMediaSource({ sourcePlatform: 'local_import', videoId: 'local-abc' }), 'other');
  assert.equal(classifyMediaSource({ videoId: 'unknown-legacy-id' }), 'other');
});

test('SQLite playlist source filter scopes pages, random samples, tags, and authors consistently', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'iwara-source-filter-'));
  const store = new SQLiteStore({ filePath: path.join(root, 'ledger.sqlite'), legacyJsonPath: path.join(root, 'none.json'), backupRoot: path.join(root, 'backups') });
  try {
    await store.load();
    const now = new Date().toISOString();
    store.state.tasks.push(
      { id: 'i-1', videoId: 'IwaraOne123', sourcePlatform: 'iwara', sourcePage: 'https://www.iwara.tv/video/IwaraOne123', state: 'completed', title: 'Iwara one', author: 'mmd-maker', tags: ['mmd', 'dance'], destination: 'X:/video/iwara-one.mp4', fileStatus: 'present', createdAt: now, updatedAt: now },
      { id: 'i-2', videoId: 'IwaraTwo123', sourcePage: 'https://www.iwara.tv/video/IwaraTwo123', state: 'completed', title: 'Iwara two', author: 'mmd-maker', tags: ['dance'], destination: 'X:/video/iwara-two.mp4', fileStatus: 'present', createdAt: now, updatedAt: now },
      { id: 'h-1', videoId: 'han1meview-123456', sourcePlatform: 'han1meview', state: 'completed', title: 'Han1', author: 'han-author', tags: ['han-tag'], destination: 'E:/han/video.mp4', fileStatus: 'present', createdAt: now, updatedAt: now },
      { id: 'local-1', videoId: 'local-abc123', sourcePlatform: 'local_import', state: 'completed', title: 'Imported', author: 'folder-author', tags: ['local-tag'], destination: 'X:/video/local.mp4', fileStatus: 'present', createdAt: now, updatedAt: now }
    );
    await store.save();
    assert.deepEqual(store.queryPlaylist({ source: 'iwara', pageSize: 30 }).tasks.map(task => task.id), ['i-1', 'i-2']);
    assert.deepEqual(store.queryPlaylist({ source: 'han1', pageSize: 30 }).tasks.map(task => task.id), ['h-1']);
    assert.equal(store.queryPlaylist({ source: 'all', pageSize: 30 }).total, 4);
    assert.deepEqual(store.queryPlaylist({ source: 'han1', randomSample: true, randomSeed: 'stable', pageSize: 30 }).tasks.map(task => task.id), ['h-1']);
    assert.deepEqual(store.playlistTags({ source: 'iwara' }).map(item => item.tag), ['dance', 'mmd']);
    assert.deepEqual(store.playlistTags({ source: 'han1' }).map(item => item.tag), ['han-tag']);
    assert.deepEqual(store.playlistAuthors('han1').map(item => item.author), ['han-author']);
    assert.deepEqual(store.playlistAuthors('iwara').map(item => item.author), ['mmd-maker']);
  } finally {
    store.close();
    await rm(root, { recursive: true, force: true });
  }
});
