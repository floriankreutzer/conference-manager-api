import { readFile, readdir } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { Readable } from 'node:stream';
import { GetObjectCommand, PutObjectCommand, DeleteObjectCommand } from '@aws-sdk/client-s3';
import { DEMO_FIXTURE } from '../../src/demo/fixture.js';
import { demoFixtureMediaReferences } from '../../src/persistence/postgres/demo-fixture-media.js';
import { createNeonObjectStorage } from '../../src/media/neon-object-storage.js';
import { createNeonBranchStorageConfig } from '../../src/media/neon-storage-config.js';

export const recoveryReferences = Object.freeze([...demoFixtureMediaReferences(DEMO_FIXTURE)]
  .sort((a, b) => a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
export const recoverySettings = Object.freeze({ branch: 'br-disposable-recovery-test',
  storage: createNeonBranchStorageConfig({ branch: 'br-disposable-recovery-test', bucket: 'conference-manager-media',
    accessKeyId: 'test-access-only', secretAccessKey: 'test-secret-material-not-a-provider-key' }) });

const imageDirectory = new URL('../../src/demo/media/', import.meta.url);
const bytesByHash = new Map();
for (const name of await readdir(imageDirectory)) {
  if (!name.endsWith('.b64')) continue;
  const bytes = Buffer.from((await readFile(new URL(name, imageDirectory), 'utf8')).trim(), 'base64');
  bytesByHash.set(createHash('sha256').update(bytes).digest('hex'), bytes);
}

export function recoveryBytes(reference) {
  return Buffer.from(bytesByHash.get(reference.sha256));
}

// Native protocol fixture only; never a real-provider recovery-success artifact.
// Both the normal unchanged adapter and the operator receive SDK command objects.
export function recoveryProviderFixture() {
  const objects = new Map(recoveryReferences.map((reference) => [reference.key,
    { bytes: recoveryBytes(reference), contentType: reference.contentType }]));
  const commands = [];
  const clients = [];
  let rejectPut = null;
  const clientFactory = (options) => {
    const client = {
      options, destroyed: false,
      async send(command) {
        const input = command.input;
        commands.push({ name: command.constructor.name, key: input.Key });
        if (command instanceof GetObjectCommand) {
          const entry = objects.get(input.Key);
          if (!entry) throw Object.assign(new Error('private provider failure'), { name: 'NoSuchKey' });
          return { ContentType: entry.contentType, ContentLength: entry.bytes.length,
            Body: Readable.from([Buffer.from(entry.bytes)]) };
        }
        if (command instanceof DeleteObjectCommand) { objects.delete(input.Key); return {}; }
        if (command instanceof PutObjectCommand) {
          if (rejectPut?.(input)) throw new Error('private provider credential diagnostic');
          objects.set(input.Key, { bytes: Buffer.from(input.Body), contentType: input.ContentType });
          return {};
        }
        throw new Error('UNEXPECTED_SDK_COMMAND');
      },
      destroy() { client.destroyed = true; },
    };
    clients.push(client);
    return client;
  };
  return { objects, commands, clients, clientFactory, rejectPuts(predicate) { rejectPut = predicate; },
    storage: createNeonObjectStorage(recoverySettings.storage, { clientFactory }) };
}
