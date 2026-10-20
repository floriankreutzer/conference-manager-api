import { createHash } from 'node:crypto';
import { cloneSyntheticBusinessTemplateData } from './business-template-data.js';

export const SYNTHETIC_BUSINESS_TEMPLATE_VERSION='saas-3.7-three-customer-business-v1';
export const SYNTHETIC_BUSINESS_TEMPLATE_DIGEST='f43a3116c7e06df8910d7368d049c30fe0d1efb97a4601157329664aca19dbdd';

// Each consumer receives its own data copy. Source integrity is independent
// from any Demo persona, provider, credential, reset or public runtime.
export function createSyntheticBusinessTemplates() {
  const data=cloneSyntheticBusinessTemplateData();
  const digest=createHash('sha256').update(JSON.stringify(data),'utf8').digest('hex');
  if (digest!==SYNTHETIC_BUSINESS_TEMPLATE_DIGEST) throw new Error('SYNTHETIC_BUSINESS_TEMPLATE_INTEGRITY_FAILED');
  return data;
}
