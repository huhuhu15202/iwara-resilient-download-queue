import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { spawn } from 'node:child_process';
const config = JSON.parse(await readFile(path.resolve(import.meta.dirname, '../config.json'), 'utf8'));
const db = new DatabaseSync(path.join(config.dataRoot, 'ledger.sqlite'), {readOnly:true});
const rows = db.prepare(`SELECT m.task_id,m.size,t.data_json FROM mobile_media_identity m JOIN tasks t ON t.id=m.task_id
  WHERE m.size BETWEEN ? AND ? ORDER BY m.size DESC LIMIT 30`).all(70*1024*1024,220*1024*1024);
db.close();
const row = rows.find(row => JSON.parse(row.data_json).destination?.toLowerCase().endsWith('.mp4'));
if (!row) throw Error('No completed original MP4 fingerprint available for the isolated copy test');
const origin = process.argv[2];
if (!origin) throw Error('Usage: node tools/verify-android-lan.mjs <authorized-service-origin>');
const token = config.lanAccessToken;
// No real token is printed or stored in the source/APK. Test arguments are transient.
const adb = process.env.IWARA_ADB || 'adb';
const child = spawn(adb, ['-P','5038','-s','emulator-5556','shell','am','instrument','-w',
  '-e','origin',origin,'-e','token',token,'-e','task',row.task_id,'-e','size',String(row.size),
  'com.mxtech.videoplayer.ad/com.iwara.tests.LanTest'], {windowsHide:true});
let output = ''; child.stdout.on('data', chunk => output += chunk); child.stderr.on('data', chunk => output += chunk);
await new Promise((resolve,reject) => {child.once('error',reject);child.once('close',resolve);});
console.log(output.replaceAll(String(token),'[hidden]'));
if (!output.includes('result=PASS:')) process.exitCode = 1;
