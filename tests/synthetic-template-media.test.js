import assert from 'node:assert/strict';
import { createHash,randomUUID } from 'node:crypto';
import test from 'node:test';
import { createSyntheticTemplateMediaSource } from '../src/media/synthetic-template-media.js';
import { createSyntheticBusinessTemplates } from '../src/synthetic/business-templates.js';
import { createSyntheticGenerationPlanner } from '../src/tenancy/synthetic-generation-plan.js';

test('fresh generation media mappings resolve every unchanged source image without Demo identity/runtime authority',async()=>{
  const source=createSyntheticTemplateMediaSource();
  const plan=createSyntheticGenerationPlanner().create({ environment: 'int',operatorId: randomUUID(),
    operatorSecurityVersion: 1,securityEpoch: randomUUID(),now: new Date('2026-10-20T12:00:00Z') });
  for (const tenant of plan.tenants) for (const media of tenant.mediaSources) {
    const bytes=await source.read(media.sourceAssetId);
    const expected=[...tenant.business.roomMedia,...tenant.business.catalogueMedia].find(item=>item.id===media.assetId);
    assert.equal(bytes.kind,media.kind);assert.equal(bytes.byteLength,expected.byteLength);
    assert.equal(bytes.sha256,expected.sha256);assert.equal(bytes.bytes.length,expected.byteLength);
    assert.equal(createHash('sha256').update(bytes.bytes).digest('hex'),expected.sha256);
    assert.equal(Object.hasOwn(bytes,'filename'),false);assert.equal(Object.hasOwn(bytes,'tenantId'),false);
  }
});

test('source selection rejects unknown IDs, filenames, URLs and traversal; each read owns its bytes',async()=>{
  const source=createSyntheticTemplateMediaSource();
  for (const id of [undefined,null,{},randomUUID(),'../demo/fixture.js','northwind-room-01.webp.b64',
    'https://127.0.0.1/image','file:///etc/passwd']) {
    await assert.rejects(source.read(id),/SYNTHETIC_MEDIA_SOURCE_UNKNOWN/);
  }
  const id=createSyntheticBusinessTemplates()[0].roomMedia[0].id;
  const first=await source.read(id),original=Buffer.from(first.bytes);first.bytes.fill(0);
  const next=await source.read(id);assert.deepEqual(next.bytes,original);
});
