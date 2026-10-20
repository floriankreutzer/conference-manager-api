import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { createSyntheticBusinessTemplates } from '../synthetic/business-templates.js';

function roomAssetKey(roomId) {
  const match=/^northwind-berlin-room-(10|[1-9])$/.exec(roomId);
  if (match) return `northwind-room-${match[1].padStart(2,'0')}`;
  if (roomId==='contoso-paris-room-1') return roomId;
  throw new Error('SYNTHETIC_MEDIA_MANIFEST_INVALID');
}

// The only filenames come from the checked fixed source manifest. Callers can
// select a known source asset ID, never a path, URL, bucket or provider object.
export function createSyntheticTemplateMediaSource() {
  const manifest=new Map();
  for (const tenant of createSyntheticBusinessTemplates()) {
    for (const media of tenant.roomMedia) manifest.set(media.id,{ ...media,kind: 'room',contentType: 'image/webp',
      filename: `${roomAssetKey(media.roomId)}.webp.b64` });
    for (const media of tenant.catalogueMedia) manifest.set(media.id,{ ...media,kind: 'catalogue',
      filename: media.contentType==='image/png' ? `rooms-${media.assetKey}-plan.png.b64` : `catering-${media.assetKey}.webp.b64` });
  }
  return Object.freeze({
    async read(sourceAssetId) {
      const media=manifest.get(sourceAssetId);
      if (!media) throw new TypeError('SYNTHETIC_MEDIA_SOURCE_UNKNOWN');
      const encoded=await readFile(new URL(`../synthetic/media/${media.filename}`,import.meta.url),'utf8');
      const bytes=Buffer.from(encoded.trim(),'base64');
      const signatureValid=media.contentType==='image/png'
        ? bytes.subarray(0,8).equals(Buffer.from('89504e470d0a1a0a','hex'))
        : bytes.toString('ascii',0,4)==='RIFF' && bytes.toString('ascii',8,12)==='WEBP';
      if (!signatureValid || bytes.length!==media.byteLength
        || createHash('sha256').update(bytes).digest('hex')!==media.sha256) throw new Error('SYNTHETIC_MEDIA_SOURCE_CORRUPT');
      return Object.freeze({ sourceAssetId,kind: media.kind,contentType: media.contentType,
        byteLength: media.byteLength,sha256: media.sha256,bytes });
    },
  });
}
