// Feed to `docker compose exec -T receipt-app node --input-type=module`.
import sharp from 'sharp';
import { Readable } from 'node:stream';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { saveImage } from './dist/server/images.js';
const dir=await mkdtemp('/tmp/receipt-resource-');
try {
  const png=await sharp({create:{width:1920,height:12000,channels:3,background:'#ffffff'}}).png().toBuffer();
  for(let i=0;i<8;i++) {const file=Readable.from(png);file.truncated=false;await saveImage({file},dir,i);}
  const peak=Number(await readFile('/sys/fs/cgroup/memory.peak','utf8'));
  console.log(JSON.stringify({test:'8 images of 1920 x 12000 pixels decoded sequentially',peakMiB:Math.round(peak/1048576*100)/100}));
} finally {await rm(dir,{recursive:true,force:true});}
