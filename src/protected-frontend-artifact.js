import { createHash } from 'node:crypto';
import { lstat,readFile,readdir } from 'node:fs/promises';
import path from 'node:path';

const MAX_FILE=2*1024*1024,MAX_TOTAL=16*1024*1024,MAX_FILES=512;
const TYPES=Object.freeze({ '.html': 'text/html; charset=utf-8','.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8','.svg': 'image/svg+xml','.ttf': 'font/ttf','.txt': 'text/plain; charset=utf-8',
  '.png': 'image/png','.webp': 'image/webp','.ico': 'image/x-icon' });
const fail=()=>{ throw new TypeError('PROTECTED_FRONTEND_ARTIFACT_INVALID'); };
const digest=bytes=>createHash('sha256').update(bytes).digest('hex');
function exact(value,keys) {
  if (!value || typeof value!=='object' || Array.isArray(value)
    || Object.keys(value).length!==keys.length || keys.some(key=>!Object.hasOwn(value,key))) fail();
}
function allowed(name,surface) {
  if (typeof name!=='string' || name.length>200 || !/^[A-Za-z0-9_./[\]-]+$/.test(name)
    || name.split('/').some(part=>!part || part==='.' || part==='..')) return false;
  const entry=surface==='customer' ? 'index.html' : 'platform-admin/index.html';
  if (name===entry) return true;
  if (name.startsWith('assets/')) return path.extname(name)!=='.html' && Object.hasOwn(TYPES,path.extname(name));
  if (!name.startsWith('src/') || !name.endsWith('.js') || /\/(?:demo\/|demo-bootstrap\.js$)/.test(name)) return false;
  return surface==='customer' ? !name.startsWith('src/platform-admin/')
    : ['src/platform-admin/','src/core/','src/shared/'].some(prefix=>name.startsWith(prefix)) || name==='src/platform/feature-flags.js';
}
async function boundedFile(file,maximum) {
  const stat=await lstat(file);if (!stat.isFile() || stat.isSymbolicLink() || stat.size<1 || stat.size>maximum) fail();
  const bytes=await readFile(file);if (bytes.length!==stat.size) fail();return bytes;
}
async function inventory(root,relative='',depth=0) {
  if (depth>10) fail();
  const stat=await lstat(path.join(root,relative));if (!stat.isDirectory() || stat.isSymbolicLink()) fail();
  const entries=await readdir(path.join(root,relative),{ withFileTypes: true });
  if (entries.length>MAX_FILES) fail();const result=[];
  for (const entry of entries) {
    const name=relative ? `${relative}/${entry.name}` : entry.name;
    if (entry.isDirectory()) result.push(...await inventory(root,name,depth+1));
    else if (entry.isFile()) result.push(name);else fail();
    if (result.length>MAX_FILES+1) fail();
  }
  return result.sort();
}

// Build artifacts are untrusted bytes until their externally pinned manifest
// and every file match this process's complete immutable deployment profile.
// This reader is not a runtime/root injection port and executes no source file.
export async function readProtectedFrontendArtifact(root,profile) {
  try {
    if (!path.isAbsolute(root) || !['customer','platform'].includes(profile.surface)
      || !/^[a-f0-9]{64}$/.test(profile.hostedFrontendSha256 ?? '')) fail();
    const names=await inventory(root),raw=await boundedFile(path.join(root,'manifest.json'),262144);
    if (digest(raw)!==profile.hostedFrontendSha256) fail();
    const manifest=JSON.parse(raw.toString('utf8'));
    exact(manifest,['schemaVersion','surface','environment','apiCommit','frontendCommit','customerOrigin','platformOrigin',
      'syntheticEnabled','microsoftEnabled','invitationsEnabled','files']);
    if (manifest.schemaVersion!==1 || ['surface','environment','apiCommit','frontendCommit','customerOrigin','platformOrigin',
      'syntheticEnabled'].some(key=>manifest[key]!==profile[key])
      || ['microsoftEnabled','invitationsEnabled'].some(key=>typeof manifest[key]!=='boolean')
      || !Array.isArray(manifest.files) || manifest.files.length<2 || manifest.files.length>MAX_FILES) fail();
    const files=new Map();let total=0,previous='';
    for (const entry of manifest.files) {
      exact(entry,['path','bytes','sha256']);
      if (!allowed(entry.path,profile.surface) || entry.path<=previous || !Number.isSafeInteger(entry.bytes)
        || entry.bytes<1 || entry.bytes>MAX_FILE || !/^[a-f0-9]{64}$/.test(entry.sha256)) fail();
      previous=entry.path;total+=entry.bytes;if (total>MAX_TOTAL) fail();
      const bytes=await boundedFile(path.join(root,entry.path),MAX_FILE);
      if (bytes.length!==entry.bytes || digest(bytes)!==entry.sha256) fail();
      files.set(entry.path,{ bytes,type: TYPES[path.extname(entry.path)] });
    }
    if (JSON.stringify(names)!==JSON.stringify(['manifest.json',...files.keys()].sort())) fail();
    const entry=profile.surface==='customer' ? 'index.html' : 'platform-admin/index.html';
    const html=files.get(entry)?.bytes.toString('utf8');if (!html) fail();
    const policies=[...html.matchAll(/<meta http-equiv="Content-Security-Policy" content="([^"]+)">/g)];
    if (policies.length!==1 || policies[0][1].length>4096 || /[\r\n]/.test(policies[0][1])) fail();
    const csp=`${policies[0][1]}; frame-ancestors 'none'`;
    return Object.freeze({ entry,csp,get(name) {
      const file=files.get(name);return file ? Object.freeze({ bytes: Buffer.from(file.bytes),type: file.type }) : null;
    } });
  } catch { throw new TypeError('PROTECTED_FRONTEND_ARTIFACT_INVALID'); }
}
