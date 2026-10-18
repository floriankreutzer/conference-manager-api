import { constants } from 'node:fs';
import { lstat, open, writeFile, rename } from 'node:fs/promises';
import { setTimeout as delay } from 'node:timers/promises';
import path from 'node:path';

// Fixed-name private IPC for connector hosts which cannot keep subprocess stdin open.
export async function createProviderWatchMailbox(directory) {
  const stat = await lstat(directory);
  if (!stat.isDirectory() || (stat.mode & 0o077) !== 0 || stat.uid !== process.getuid()) throw new Error('PRIVATE_DIRECTORY');
  const filename = (name) => path.join(directory, name);
  async function read(name) {
    for (;;) {
      let file;
      try {
        file = await open(filename(name), constants.O_RDONLY | constants.O_NOFOLLOW);
        const info = await file.stat();
        if (!info.isFile() || info.size > 524_288 || (info.mode & 0o077) !== 0 || info.uid !== process.getuid()) {
          throw new Error('PRIVATE_FILE');
        }
        const buffer = Buffer.alloc(524_289);
        const { bytesRead } = await file.read(buffer, 0, buffer.length, 0);
        if (bytesRead > 524_288) throw new Error('BOUNDED');
        return JSON.parse(buffer.subarray(0, bytesRead).toString('utf8'));
      } catch (error) {
        if (error.code !== 'ENOENT') throw error;
      } finally { await file?.close(); }
      await delay(100);
    }
  }
  async function write(name, value) {
    const target = filename(name);
    await writeFile(`${target}.next`, JSON.stringify(value), { mode: 0o600, flag: 'wx' });
    await rename(`${target}.next`, target);
  }
  return { read, write };
}
