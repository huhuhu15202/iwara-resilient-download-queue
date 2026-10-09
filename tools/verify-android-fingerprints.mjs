import { mkdir, writeFile, readdir } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { randomUUID, createHash } from 'node:crypto';
import { sampleFingerprint } from '../src/mobile-library.mjs';

const tools = 'F:/IwaraVideos/R18/AndroidBuildTools';
const jdk = (await readdir(tools)).find(name => name.startsWith('jdk-'));
const javaBin = path.join(tools, jdk, 'bin');
const root = path.join(tools, 'work', `fingerprint-test-${randomUUID()}`); await mkdir(root, { recursive: true });
const fixture = path.join(root, 'fixture.bin'); const data = Buffer.alloc(235777);
for (let i = 0; i < data.length; i++) data[i] = i % 251;
await writeFile(fixture, data);
const sample = await sampleFingerprint(fixture, data.length);
const sha = createHash('sha256').update(data).digest('hex');
for (const [program, args] of [
  ['javac.exe', ['-encoding', 'UTF-8', '-d', root, path.resolve('android/app/src/com/iwara/local/Fingerprints.java'), path.resolve('android/test/FingerprintTest.java')]],
  ['java.exe', ['-cp', root, 'FingerprintTest', fixture, sample, sha]]
]) {
  const result = spawnSync(path.join(javaBin, program), args, { encoding: 'utf8', windowsHide: true });
  if (result.stdout) process.stdout.write(result.stdout); if (result.stderr) process.stderr.write(result.stderr);
  if (result.status !== 0) throw new Error(`${program} failed`);
}
