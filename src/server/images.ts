import { mkdir, rm, readdir, rename, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { pipeline } from 'node:stream/promises';
import { createWriteStream } from 'node:fs';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import sharp from 'sharp';
import type { MultipartFile } from '@fastify/multipart';
import { fail, id, Store, now } from './db.js';
sharp.cache(false); sharp.concurrency(1);
const execFileAsync = promisify(execFile);
const archiveQualities = [92, 90, 88] as const;
const archiveTarget = 1.5 * 1024 * 1024;

async function createArchive(source: string, dir: string, imageID: string) {
  const archive = join(dir, imageID + '.webp'), temporary = archive + '.tmp';
  for (const quality of archiveQualities) {
    await rm(temporary, { force: true });
    await sharp(source, { limitInputPixels: 32_000_000, failOn: 'warning' }).rotate().webp({ quality, effort: 6, smartSubsample: true }).toFile(temporary);
    if ((await stat(temporary)).size <= archiveTarget || quality === archiveQualities.at(-1)) break;
  }
  await rename(temporary, archive);
  return archive;
}

export async function saveImage(part: MultipartFile, dir: string, position: number) {
  await mkdir(dir, { recursive: true, mode: 0o700 });
  const imageID = id(), upload = join(dir, imageID + '.upload'), converted = join(dir, imageID + '.decoded.png'), thumbnail = join(dir, imageID + '.jpg');
  let path = join(dir, imageID + '.webp');
  try {
    await pipeline(part.file, createWriteStream(upload, { mode: 0o600, flags: 'wx' }));
    if (part.file.truncated) fail('每张图片上限为 15 MiB', 413);
    const metadata = await sharp(upload, { limitInputPixels: 32_000_000, failOn: 'warning' }).metadata();
    const heic = metadata.format === 'heif' && metadata.compression === 'hevc';
    if (!(['jpeg', 'png', 'webp'].includes(metadata.format || '') || heic) || (metadata.pages || 1) > 1) fail('请选择 JPG、PNG、静态 WebP 或单张 HEIC 图片');
    if (!metadata.width || !metadata.height || metadata.width * metadata.height > 32_000_000) fail('图片像素超过 3200 万，请使用较小的照片');
    if (heic) {
      try { await execFileAsync('heif-convert', [upload, converted], { timeout: 60_000, maxBuffer: 64 * 1024 }); }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') fail('服务器缺少 HEIC 转换工具，请安装 libheif-examples', 503);
        fail('HEIC 图片解码失败，请确认文件完整且为单张照片', 400);
      }
    }
    const source = heic ? converted : upload;
    path = await createArchive(source, dir, imageID);
    await sharp(source, { limitInputPixels: 32_000_000, failOn: 'warning' }).rotate().resize({ width: 1920, height: 12000, fit: 'inside', withoutEnlargement: true }).jpeg({ quality: 82 }).toFile(thumbnail);
    if ((await stat(thumbnail)).size > 3 * 1024 * 1024) fail('图片内容过长，请拆成多张上传');
    await rm(upload, { force: true });
    await rm(converted, { force: true });
    return { id: imageID, position, path, thumbnail };
  } catch (e) { await rm(upload, { force: true }); await rm(converted, { force: true }); await rm(path, { force: true }); await rm(path + '.tmp', { force: true }); await rm(thumbnail, { force: true }); if ((e as any)?.statusCode) throw e; fail('图片解码失败，请使用有效的 JPG、PNG、静态 WebP 或 HEIC 图片', 400); }
}
export async function cleanupImages(store: Store) {
  for (const row of store.all('SELECT * FROM cleanup_queue WHERE next_at<=?', now())) {
    try {
      const dir = join(store.dir, 'images', row.receipt_id);
      if (row.remove_record) {
        await rm(dir, { recursive: true, force: true });
        store.tx(() => {
          store.run('DELETE FROM images WHERE receipt_id=?', row.receipt_id);
          store.run('DELETE FROM submissions WHERE receipt_id=?', row.receipt_id);
          store.run('DELETE FROM cleanup_queue WHERE receipt_id=?', row.receipt_id);
          store.run('DELETE FROM receipts WHERE id=?', row.receipt_id);
        });
      } else {
        for (const image of store.all('SELECT * FROM images WHERE receipt_id=?', row.receipt_id)) {
          const sourceExists = await stat(image.path).then(() => true).catch(() => false);
          if (!sourceExists) {
            await rm(image.thumbnail, { force: true });
            store.run('DELETE FROM images WHERE id=?', image.id);
            continue;
          }
          let archive = image.path;
          if (!archive.endsWith('.webp')) {
            archive = await createArchive(image.path, dir, image.id);
            store.run('UPDATE images SET path=? WHERE id=?', archive, image.id);
            await rm(image.path, { force: true });
          }
          if (image.thumbnail !== archive) await rm(image.thumbnail, { force: true });
        }
        store.tx(() => {
          store.run('DELETE FROM cleanup_queue WHERE receipt_id=?', row.receipt_id);
          store.run("UPDATE receipts SET cleanup='done' WHERE id=?", row.receipt_id);
        });
      }
    } catch { store.run('UPDATE cleanup_queue SET attempts=attempts+1,next_at=? WHERE receipt_id=?', now() + Math.min(3600000, 5000 * 2 ** Math.min(row.attempts, 10)), row.receipt_id); store.run("UPDATE receipts SET cleanup='retry' WHERE id=?", row.receipt_id); }
  }
}
export async function removeOrphanImages(store: Store) {
  const root = join(store.dir, 'images'); await mkdir(root, { recursive: true, mode: 0o700 });
  for (const entry of await readdir(root, { withFileTypes: true })) {
    if (entry.isDirectory() && !store.get('SELECT id FROM receipts WHERE id=?', entry.name)) await rm(join(root, entry.name), { recursive: true, force: true });
  }
}
