import { mkdir, readFile } from 'node:fs/promises';
import { DatabaseSync, backup } from 'node:sqlite';
import path from 'node:path';
import { SQLiteStore } from '../src/sqlite-store.mjs';
import { MobileLibrary } from '../src/mobile-library.mjs';
import { createServer } from '../src/server.mjs';

// Isolated catalogue copy. No download scheduler or production writes.
const config = JSON.parse(await readFile(path.resolve(import.meta.dirname,'../config.json'),'utf8'));
const root = process.argv[2]; if (!root || !path.isAbsolute(root)) throw new Error('Provide a private absolute test directory');
await mkdir(root,{recursive:true});
const source = new DatabaseSync(path.join(config.dataRoot,'ledger.sqlite'),{readOnly:true});
try { await backup(source,path.join(root,'ledger.sqlite')); } finally { source.close(); }
const store = new SQLiteStore({filePath:path.join(root,'ledger.sqlite'),backupRoot:path.join(root,'backups'),legacyJsonPath:path.join(root,'none.json')}); await store.load();
const mobileLibrary = new MobileLibrary({store,root:config.downloadRoot,exportRoot:path.join(root,'exports'),externalProgressFile:path.join(config.dataRoot,'mobile-fingerprint-progress.json')});
const service = createServer({scheduler:{status:()=>({ok:true})},host:'127.0.0.1',port:18879,accessToken:'isolated-mobile-test',mobileLibrary,onShutdown:()=>void stop()});
await service.listen();console.log('Isolated mobile sync test server on 18879');
async function stop(){await service.close();await mobileLibrary.stop();store.close();process.exit(0);}
process.on('SIGINT',()=>void stop());process.on('SIGTERM',()=>void stop());
