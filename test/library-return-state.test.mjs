import test from 'node:test';
import assert from 'node:assert/strict';
import { Script } from 'node:vm';
import { libraryReturnStateScript, parseLibraryReturnState } from '../src/library-return-state.mjs';
import { playbackExperienceScript } from '../src/playback-experience-ui.mjs';

const now = 1_800_000_000_000;
const url = 'http://127.0.0.1:18777/recommend?profile=local&query=dance&shuffle=123';
const state = {version:1,savedAt:now,url,page:1,total:20,seed:'123',scrollY:750,anchorId:'b',anchorOffset:70,items:[{id:'a'},{id:'b'}]};

test('library return state preserves the same random batch and scroll anchor', () => {
  assert.deepEqual(parseLibraryReturnState(JSON.stringify(state),url,now+1000),state);
  assert.equal(parseLibraryReturnState(state,url.replace('shuffle=123','shuffle=124'),now),null);
  assert.equal(parseLibraryReturnState(state,url.replace('query=dance','query=blender'),now),null);
});

test('library return state ignores access tokens but not the host, mode or scope', () => {
  assert.deepEqual(parseLibraryReturnState(state,url+'&access_token=secret',now),state);
  assert.equal(parseLibraryReturnState(state,url.replace('127.0.0.1','192.0.2.10'),now),null);
  assert.equal(parseLibraryReturnState(state,url.replace('profile=local','profile=remote'),now),null);
  assert.equal(parseLibraryReturnState(state,'http://127.0.0.1:18777/player?play=a',now),null);
});

test('library return state rejects stale, malformed and unbounded snapshots', () => {
  assert.equal(parseLibraryReturnState(state,url,now+30*60*1000+1),null);
  assert.equal(parseLibraryReturnState('{',url,now),null);
  assert.equal(parseLibraryReturnState({...state,items:[{id:'a'},{id:'a'}]},url,now),null);
  assert.equal(parseLibraryReturnState({...state,page:0},url,now),null);
  assert.equal(parseLibraryReturnState({...state,total:0},url,now),null);
  assert.equal(parseLibraryReturnState({...state,total:3001,items:Array.from({length:3001},(_,i)=>({id:String(i)}))},url,now),null);
});

test('UI enhancement scripts parse and keep native media and explicit sheet choices', () => {
  assert.doesNotThrow(()=>new Script(libraryReturnStateScript()));
  const ui = playbackExperienceScript();
  assert.doesNotThrow(()=>new Script(ui));
  assert.match(ui,/dialog\.showModal\(\)/);
  assert.match(ui,/setPlaybackMode\(mode\)/);
  assert.match(ui,/应用/);
  assert.doesNotMatch(ui,/new Plyr|\.innerHTML\s*=.*<video/);
});
