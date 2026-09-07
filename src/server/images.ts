import { mkdir, rm, readdir, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { pipeline } from 'node:stream/promises';
import { createWriteStream } from 'node:fs';
import sharp from 'sharp';
import type { MultipartFile } from '@fastify/multipart';
import { fail, id, Store, now } from './db.js';
sharp.cache(false); sharp.concurrency(1);
export async function saveImage(part: MultipartFile, dir: string, position: number) {
  await mkdir(dir, { recursive: true, mode: 0o700 });
  const imageID = id(), path = join(dir, imageID + '.original'), thumbnail = join(dir, imageID + '.jpg');
  try {
    await pipeline(part.file, createWriteStream(path, { mode: 0o600, flags: 'wx' }));
    if (part.file.truncated) fail('每张图片上限为 15 MiB', 413);
    const metadata = await sharp(path, { limitInputPixels: 32_000_000, failOn: 'warning' }).metadata();
    if (!['jpeg', 'png', 'webp'].includes(metadata.format || '') || (metadata.pages || 1) > 1) fail('请选择 JPG、PNG 或静态 WebP 图片');
    await sharp(path, { limitInputPixels: 32_000_000, failOn: 'warning' }).rotate().resize({ width: 1920, height: 12000, fit: 'inside', withoutEnlargement: true }).jpeg({ quality: 82 }).toFile(thumbnail);
    if ((await stat(thumbnail)).size > 3 * 1024 * 1024) fail('图片内容过长，请拆成多张上传');
    return { id: imageID, position, path, thumbnail };
  } catch (e) { await rm(path, { force: true }); await rm(thumbnail, { force: true }); if ((e as any)?.statusCode) throw e; fail('图片解码失败，请使用有效的 JPG、PNG 或静态 WebP 图片', 400); }
}
export async function cleanupImages(store: Store) {
  for (const row of store.all('SELECT * FROM cleanup_queue WHERE next_at<=?', now())) {
    try {
      await rm(join(store.dir, 'images', row.receipt_id), { recursive: true, force: true });
      store.tx(() => {
        store.run('DELETE FROM images WHERE receipt_id=?', row.receipt_id); store.run('DELETE FROM cleanup_queue WHERE receipt_id=?', row.receipt_id);
        if (row.remove_record) store.run('DELETE FROM receipts WHERE id=?', row.receipt_id); else store.run("UPDATE receipts SET cleanup='done' WHERE id=?", row.receipt_id);
      });
    } catch { store.run('UPDATE cleanup_queue SET attempts=attempts+1,next_at=? WHERE receipt_id=?', now() + Math.min(3600000, 5000 * 2 ** Math.min(row.attempts, 10)), row.receipt_id); store.run("UPDATE receipts SET cleanup='retry' WHERE id=?", row.receipt_id); }
  }
}
export async function removeOrphanImages(store: Store) {
  const root = join(store.dir, 'images'); await mkdir(root, { recursive: true, mode: 0o700 });
  for (const entry of await readdir(root, { withFileTypes: true })) {
    if (entry.isDirectory() && !store.get('SELECT id FROM receipts WHERE id=?', entry.name)) await rm(join(root, entry.name), { recursive: true, force: true });
  }
}
