import assert from 'node:assert/strict';
import test from 'node:test';
import { normalizeCateringConfiguration } from '../src/integrations/catering-configuration.js';

const registration = (id = 'reference_caterer') => ({
  id, runtime: 'demo', capabilities: { 'catering.catalogue': 'api', 'catering.order': 'manual' },
});
const configuration = () => ({
  initialOrderMode: 'after_conference_approval', capabilities: { 'catering.catalogue': 'api', 'catering.order': 'manual' },
});

test('provider configurations are independent, immutable and do not implicitly activate omitted capabilities', () => {
  const source = configuration();
  const first = normalizeCateringConfiguration(source, registration());
  const second = normalizeCateringConfiguration({ ...configuration(), initialOrderMode: 'manager_review' },
    registration('another_caterer'));
  assert.equal(first.initialOrderMode, 'after_conference_approval');
  assert.equal(second.initialOrderMode, 'manager_review');
  assert.equal(second.providerId, 'another_caterer');
  assert.equal(first.capabilities['catering.cancel'], 'unsupported');
  source.capabilities['catering.catalogue'] = 'unsupported';
  assert.equal(first.capabilities['catering.catalogue'], 'api');
  assert.throws(() => { first.capabilities['catering.order'] = 'api'; }, TypeError);
});

test('configuration may disable capabilities but cannot upgrade manual or unsupported capabilities', () => {
  const disabled = normalizeCateringConfiguration({ ...configuration(), capabilities: {} }, registration());
  assert.ok(Object.values(disabled.capabilities).every((mode) => mode === 'unsupported'));
  for (const capabilities of [
    { 'catering.order': 'api' }, { 'catering.cancel': 'api' }, { 'catering.catalogue': 'manual' },
    { 'catering.order': 'connected' }, { 'calendar.create': 'api' }, { 'unknown.operation': 'manual' },
  ]) assert.throws(() => normalizeCateringConfiguration({ ...configuration(), capabilities }, registration()), /CONFIGURATION_INVALID/);
  assert.throws(() => normalizeCateringConfiguration(configuration(), {
    ...registration(), capabilities: { 'calendar.availability': 'api' },
  }), /CONFIGURATION_INVALID/);
});

test('configuration cannot carry Tenant, credential, endpoint, provider or business approval authority', () => {
  for (const field of ['tenantId', 'providerId', 'integrationId', 'credentials', 'secretReference', 'endpoint', 'approved']) {
    assert.throws(() => normalizeCateringConfiguration({ ...configuration(), [field]: 'untrusted' }, registration()),
      { message: 'CATERING_CONFIGURATION_INVALID' });
  }
  for (const value of [null, [], {}, { ...configuration(), initialOrderMode: 'automatic' },
    { ...configuration(), capabilities: null }, Object.create(configuration())]) {
    assert.throws(() => normalizeCateringConfiguration(value, registration()), /CONFIGURATION_INVALID/);
  }
  let invoked = false;
  const input = configuration();
  Object.defineProperty(input, 'initialOrderMode', { enumerable: true, get() { invoked = true; return 'manager_review'; } });
  assert.throws(() => normalizeCateringConfiguration(input, registration()), /CONFIGURATION_INVALID/);
  assert.equal(invoked, false);
});
