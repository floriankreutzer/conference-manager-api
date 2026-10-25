import { createHash } from 'node:crypto';
import { mkdir,writeFile } from 'node:fs/promises';
import path from 'node:path';

export const frontendArtifactDigest=bytes=>createHash('sha256').update(bytes).digest('hex');
export async function writeProtectedFrontendFixture(root,profile) {
  const entry=profile.surface==='customer' ? 'index.html' : 'platform-admin/index.html';
  const content={ [entry]: Buffer.from('<!doctype html><meta http-equiv="Content-Security-Policy" content="default-src \'self\'">'),
    'assets/fixture.css': Buffer.from('body { color: black; }\n') };
  const manifest={ schemaVersion: 1,...profile,microsoftEnabled: false,invitationsEnabled: false,ownerAccessEnabled: profile.ownerCustomerAccessEnabled===true,
    files: Object.keys(content).sort().map(name=>({ path: name,bytes: content[name].length,
      sha256: frontendArtifactDigest(content[name]) })) };
  delete manifest.hostedFrontendSha256;delete manifest.ownerCustomerAccessEnabled;
  await mkdir(root,{ recursive: true });
  for (const [name,bytes] of Object.entries(content)) {
    await mkdir(path.dirname(path.join(root,name)),{ recursive: true });await writeFile(path.join(root,name),bytes);
  }
  const raw=Buffer.from(JSON.stringify(manifest)+'\n');await writeFile(path.join(root,'manifest.json'),raw);
  return { ...profile,hostedFrontendSha256: frontendArtifactDigest(raw) };
}
