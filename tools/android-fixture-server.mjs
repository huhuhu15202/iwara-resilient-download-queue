import { createServer } from 'node:http';
import { createReadStream } from 'node:fs';
import { mkdir, readFile, stat } from 'node:fs/promises';
import { DatabaseSync } from 'node:sqlite';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { sampleFingerprint } from '../src/mobile-library.mjs';
const root=process.argv[2];if(!root||!path.isAbsolute(root))throw Error('Absolute isolated fixture directory required');await mkdir(root,{recursive:true});
for(const [name,color] of Object.entries({red:'red',blue:'blue',green:'green',unknown:'yellow'})){
  const result=spawnSync('C:/Users/14764/scoop/shims/ffmpeg.exe',['-hide_banner','-loglevel','error','-y','-f','lavfi','-i',`color=c=${color}:s=640x360:d=2`,'-f','lavfi','-i','sine=frequency=440:duration=2','-c:v','libx264','-preset','ultrafast','-pix_fmt','yuv420p','-c:a','aac','-shortest',path.join(root,name+'.mp4')],{windowsHide:true});if(result.status!==0)throw Error('Fixture FFmpeg failed');
}
const file=path.join(root,'catalog.sqlite');const db=new DatabaseSync(file);db.exec('PRAGMA user_version=2;CREATE TABLE catalogue(task_id TEXT PRIMARY KEY,video_id TEXT,title TEXT,author TEXT,upload_time INTEGER,views INTEGER,tags TEXT,size INTEGER,sha256 TEXT,sample_sha256 TEXT,download_time INTEGER,source TEXT NOT NULL DEFAULT \'other\');CREATE TABLE catalogue_meta(key TEXT PRIMARY KEY,value TEXT);');
for(const [id,videoId,name,tags,source] of [['test-red','iwara-red-001','red',['dance'],'iwara'],['test-blue','han1meview-301','blue',['blender'],'han1'],['duplicate-green-1','iwara-green-001','green',['test'],'iwara'],['duplicate-green-2','local-fixture-unknown','green',['test'],'other']]){
  const file=path.join(root,name+'.mp4');const content=await readFile(file);db.prepare('INSERT INTO catalogue VALUES(?,?,?,?,?,?,?,?,?,?,?,?)').run(id,videoId,`隔离测试 ${name}`,'测试作者',1720000000,12345,JSON.stringify(tags),content.length,createHash('sha256').update(content).digest('hex'),await sampleFingerprint(file,content.length),null,source);
}db.close();
const server=createServer(async(req,res)=>{if(req.headers['x-iwara-access-token']!=='isolated-test'){res.writeHead(401);res.end();return;}const name=req.url.slice(1);if(!['catalog.sqlite','red.mp4','blue.mp4','green.mp4','unknown.mp4'].includes(name)){res.writeHead(404);res.end();return;}const file=path.join(root,name);res.writeHead(200,{'content-length':(await stat(file)).size});createReadStream(file).pipe(res);});
await new Promise(resolve=>server.listen(18880,'127.0.0.1',resolve));console.log('Synthetic Android test fixtures on 18880');
