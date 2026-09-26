import assert from 'node:assert/strict';
import test from 'node:test';
import sharp from 'sharp';
import {
  processRoomImage,
  ROOM_IMAGE_INPUT_MAX_BYTES,
  RoomImageInputError,
} from '../src/media/room-image-processor.js';

const pixel = { create: { width: 2, height: 3, channels: 3, background: '#ee4040' } };

test('decodes accepted formats into a bounded metadata-free WebP image', async () => {
  for (const [format, contentType] of [['png', 'image/png'], ['jpeg', 'image/jpeg'], ['webp', 'image/webp']]) {
    const bytes = await sharp(pixel)[format]().toBuffer();
    const output = await processRoomImage({ bytes, contentType });
    const decoded = await sharp(output.bytes).metadata();
    assert.deepEqual([output.width, output.height, output.contentType], [2, 3, 'image/webp']);
    assert.equal(decoded.format, 'webp');
    assert.equal(decoded.exif, undefined);
    assert.equal(decoded.xmp, undefined);
    assert.equal(decoded.icc, undefined);
  }
  const withSensitiveExif = await sharp(pixel).jpeg()
    .withExif({ IFD0: { Copyright: 'private-data' } }).toBuffer();
  assert.ok((await sharp(withSensitiveExif).metadata()).exif);
  const cleaned = await processRoomImage({ bytes: withSensitiveExif, contentType: 'image/jpeg' });
  assert.equal((await sharp(cleaned.bytes).metadata()).exif, undefined);
});

test('rejects forged type, malformed bytes, oversized input, excessive pixels, and multiple frames', async () => {
  const png = await sharp(pixel).png().toBuffer();
  const jpeg = await sharp(pixel).jpeg().toBuffer();
  const webp = await sharp(pixel).webp().toBuffer();
  // Two-frame WebP test fixture, generated from 2x3 red and blue frames.
  const animated = Buffer.from([
    'UklGRsAAAABXRUJQVlA4WAoAAAACAAAAAQAAAgAAQU5JTQYAAAD/////AABBTk1GSAAAAAAAAAAAAAEAAAIAAGQAAAJWUDggMAAAANABAJ0B',
    'KgIAAwACADQloAJ0ugH4AAOwAP7wxAv/ILlhdcjX/yA/5Af8gP/48gAAAEFOTUZEAAAAAAAAAAAAAQAAAgAAZAAAAFZQOCAsAAAAlAEAn',
    'QEqAgADAAAANCWgAnS6AAOYAP75k2//kB//kB//kB//ID/iF3sgMAA=',
  ].join(''), 'base64');
  const invalid = [
    { bytes: png, contentType: 'image/jpeg' },
    { bytes: png, contentType: 'image/svg+xml' },
    { bytes: Buffer.from('not an image'), contentType: 'image/png' },
    { bytes: Buffer.alloc(ROOM_IMAGE_INPUT_MAX_BYTES + 1), contentType: 'image/png' },
    { bytes: Buffer.concat([png, Buffer.from('<script>')]), contentType: 'image/png' },
    { bytes: Buffer.concat([jpeg, Buffer.from('<script>')]), contentType: 'image/jpeg' },
    { bytes: Buffer.concat([webp, Buffer.from('<script>')]), contentType: 'image/webp' },
    { bytes: animated, contentType: 'image/webp' },
    {
      bytes: await sharp({ create: { width: 2_001, height: 2_000, channels: 3, background: '#000000' } })
        .png().toBuffer(),
      contentType: 'image/png',
    },
  ];
  for (const input of invalid) {
    await assert.rejects(processRoomImage(input), RoomImageInputError);
  }
});
