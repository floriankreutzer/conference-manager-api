import { isInternalUuid } from './identifiers.js';
import { normalizeMoney } from './money.js';
import { normalizeTenantCatalogue } from './tenant-catalogue.js';
import { normalizeCateringCatalogueAssignments } from './catering-catalogue-assignments.js';
import { normalizeCateringProviderCatalogue } from './catering-provider-catalogue.js';

const ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const key = (kind, id) => `${kind}:${id}`;
function invalid(code = 'CATERING_CATALOGUE_PUBLICATION_INVALID') { throw new TypeError(code); }
function record(value, keys) {
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) invalid();
  const own = Reflect.ownKeys(value);
  if (own.length !== keys.length || own.some((name) => {
    const descriptor = Object.getOwnPropertyDescriptor(value, name);
    return !keys.includes(name) || !descriptor.enumerable || !Object.hasOwn(descriptor, 'value');
  })) invalid();
}
function array(value, limit) {
  if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype || value.length > limit
    || Reflect.ownKeys(value).length !== value.length + 1) invalid();
  for (let i = 0; i < value.length; i++) {
    const descriptor = Object.getOwnPropertyDescriptor(value, String(i));
    if (!descriptor?.enumerable || !Object.hasOwn(descriptor, 'value')) invalid();
  }
  return value;
}
function id(value) { if (typeof value !== 'string' || !ID.test(value)) invalid(); return value; }
function uuid(value) { if (!isInternalUuid(value)) invalid(); return value.toLowerCase(); }
function revision(value, minimum = 1) {
  if (!Number.isSafeInteger(value) || value < minimum || value > Number.MAX_SAFE_INTEGER - 2) invalid();
  return value;
}
function identifiers(value) {
  const result = array(value, 200).map(id);
  if (new Set(result).size !== result.length) invalid();
  return Object.freeze(result.sort());
}
function commercial(value) {
  record(value.price, ['amountMinor', 'currency']);
  if (typeof value.active !== 'boolean' || !Number.isSafeInteger(value.order) || value.order < 0 || value.order > 100000) invalid();
  return { price: normalizeMoney(value.price), active: value.active, order: value.order };
}
function distinct(values, property) {
  if (new Set(values.map((value) => value[property])).size !== values.length) invalid();
}
function mapping(value, variant = false, group = false) {
  record(value, ['sourceId', 'entryId', 'price', 'active', 'order',
    ...(variant ? [] : ['siteIds', 'roomIds']), ...(group ? ['variants'] : [])]);
  const result = { sourceId: id(value.sourceId), entryId: id(value.entryId), ...commercial(value),
    ...(variant ? {} : { siteIds: identifiers(value.siteIds), roomIds: identifiers(value.roomIds) }) };
  if (group) {
    result.variants = Object.freeze(array(value.variants, 20).map((entry) => mapping(entry, true)));
    distinct(result.variants, 'sourceId'); distinct(result.variants, 'entryId');
  }
  return Object.freeze(result);
}
function sourceProduct(source, entryId) {
  const product = source.find((entry) => entry.id === entryId);
  if (!product) invalid('CATERING_CATALOGUE_PUBLICATION_SOURCE_UNKNOWN');
  return product;
}
function canonicalProduct(product, selected) {
  return { id: selected.entryId, name: product.name, description: product.description,
    price: selected.price, active: selected.active, order: selected.order,
    siteIds: selected.siteIds, roomIds: selected.roomIds };
}
function previousBindings(value, catalogue) {
  const entries = new Map([...catalogue.cateringItems.map((entry) => [key('item',entry.id),entry]),
    ...catalogue.cateringPackages.map((entry) => [key('package',entry.id),entry])]);
  const seen = new Set();
  return array(value, 400).map((binding) => {
    record(binding, ['kind','entryId','sourceId','variants']);
    if (!['item','package'].includes(binding.kind)) invalid();
    id(binding.entryId); id(binding.sourceId);
    const identifier = key(binding.kind,binding.entryId);
    const current = entries.get(identifier);
    if (!current || seen.has(identifier)) invalid(); seen.add(identifier);
    const variants = array(binding.variants,20).map((variant) => {
      record(variant,['entryId','sourceId']); id(variant.entryId); id(variant.sourceId);
      if (binding.kind !== 'package' || !current.variants.some((entry) => entry.id === variant.entryId)) invalid();
      return Object.freeze({ entryId: variant.entryId, sourceId: variant.sourceId });
    });
    distinct(variants,'entryId'); distinct(variants,'sourceId');
    return Object.freeze({ kind: binding.kind, entryId: binding.entryId, sourceId: binding.sourceId,
      variants: Object.freeze(variants) });
  });
}

// Canonical command intent can be retained for exact replay independently of
// later source/catalogue changes. It contains no Tenant or provider authority.
export function normalizeCateringCataloguePublicationCommand(value) {
  record(value, ['schemaVersion','commandId','expectedSourceRevision','expectedConfigurationRevision',
    'expectedCatalogueRevision','expectedAssignmentRevision','expectedPublicationRevision','items','packages']);
  if (value.schemaVersion !== 1) invalid(); const commandId = uuid(value.commandId);
  const items = array(value.items,300).map((entry) => mapping(entry));
  const packages = array(value.packages,100).map((entry) => mapping(entry,false,true));
  distinct(items,'sourceId'); distinct(items,'entryId'); distinct(packages,'sourceId'); distinct(packages,'entryId');
  const expected = {};
  for (const field of ['Source','Configuration','Catalogue','Assignment','Publication']) {
    expected[`expected${field}Revision`] = revision(value[`expected${field}Revision`],
      ['Assignment','Publication'].includes(field) ? 0 : 1);
  }
  const compareSource = (left,right) => left.sourceId < right.sourceId ? -1 : left.sourceId > right.sourceId ? 1 : 0;
  return Object.freeze({ schemaVersion: 1,commandId,...expected,items: Object.freeze(items.sort(compareSource)),
    packages: Object.freeze(packages.map((entry) => Object.freeze({ ...entry,
      variants: Object.freeze([...entry.variants].sort(compareSource)) })).sort(compareSource)) });
}

// Pure review planning only. Independently loaded source, canonical catalogue,
// assignment state and live authorization/CAS must be fenced by the use case.
// The result is not persistence, publication, availability or order authority.
export function planCateringCataloguePublication(value, expected) {
  record(expected, ['tenantId','integrationId','sourceRevision','configurationRevision','catalogueRevision',
    'assignmentRevision','publicationRevision','source','catalogue','assignments','connections','previousBindings']);
  const tenantId = uuid(expected.tenantId); const integrationId = uuid(expected.integrationId);
  const sourceRevision = revision(expected.sourceRevision);
  const configurationRevision = revision(expected.configurationRevision);
  const catalogueRevision = revision(expected.catalogueRevision);
  const assignmentRevision = revision(expected.assignmentRevision, 0);
  const publicationRevision = revision(expected.publicationRevision, 0);
  const catalogue = normalizeTenantCatalogue(expected.catalogue);
  const source = normalizeCateringProviderCatalogue(expected.source, { tenantId, integrationId });
  const ownership = normalizeCateringCatalogueAssignments({ schemaVersion: 1, catalogueRevision,
    assignments: expected.assignments }, { tenantId, catalogueRevision, catalogue, connections: expected.connections });
  if (assignmentRevision === 0 && ownership.assignments.length !== 0) invalid();
  if (!expected.connections.some((entry) => entry.integrationId.toLowerCase() === integrationId)) invalid();
  const owners = new Map(ownership.assignments.map((entry) => [key(entry.kind,entry.entryId),entry.integrationId]));
  const previous = previousBindings(expected.previousBindings,catalogue);
  const command = normalizeCateringCataloguePublicationCommand(value);
  for (const [field, actual] of [['Source',sourceRevision],['Configuration',configurationRevision],
    ['Catalogue',catalogueRevision],['Assignment',assignmentRevision],['Publication',publicationRevision]]) {
    if (revision(command[`expected${field}Revision`], ['Publication','Assignment'].includes(field) ? 0 : 1) !== actual) {
      invalid('CATERING_CATALOGUE_PUBLICATION_REVISION_CONFLICT');
    }
  }
  const { commandId,items,packages } = command;
  const proposedItems = new Map(catalogue.cateringItems.map((entry) => [entry.id, entry]));
  const proposedPackages = new Map(catalogue.cateringPackages.map((entry) => [entry.id, entry]));
  const selectedKeys = new Set([...items.map((entry) => key('item',entry.entryId)),
    ...packages.map((entry) => key('package',entry.entryId))]);
  for (const binding of previous) {
    if (owners.get(key(binding.kind,binding.entryId)) !== integrationId || selectedKeys.has(key(binding.kind,binding.entryId))) continue;
    const collection = binding.kind === 'item' ? proposedItems : proposedPackages;
    const entry = collection.get(binding.entryId);
    collection.set(binding.entryId, { ...entry, active: false,
      ...(binding.kind === 'package'
        ? { variants: entry.variants.map((variant) => ({ ...variant, active: false })) } : {}) });
  }
  const bindings = [];
  function own(kind, entryId) {
    const owner = owners.get(key(kind,entryId));
    if (owner !== undefined && owner !== integrationId) invalid('CATERING_CATALOGUE_PUBLICATION_OWNER_CONFLICT');
    owners.set(key(kind,entryId),integrationId);
  }
  for (const selected of items) {
    own('item',selected.entryId);
    proposedItems.set(selected.entryId,canonicalProduct(sourceProduct(source.items,selected.sourceId),selected));
    bindings.push(Object.freeze({ kind: 'item', entryId: selected.entryId, sourceId: selected.sourceId,
      variants: Object.freeze([]) }));
  }
  const itemBySource = new Map(items.map((entry) => [entry.sourceId,entry]));
  for (const selected of packages) {
    own('package',selected.entryId);
    const product = sourceProduct(source.packages,selected.sourceId);
    const itemIds = product.itemIds.map((sourceId) => {
      const component = itemBySource.get(sourceId);
      if (!component) invalid('CATERING_CATALOGUE_PUBLICATION_COMPONENT_UNREVIEWED');
      return component.entryId;
    });
    const variants = selected.variants.map((variant) => {
      const detail = sourceProduct(product.variants,variant.sourceId);
      return { id: variant.entryId, name: detail.name, description: detail.description,
        price: variant.price, active: variant.active, order: variant.order };
    });
    const variantIds = new Set(variants.map((entry) => entry.id));
    for (const old of proposedPackages.get(selected.entryId)?.variants ?? []) {
      if (!variantIds.has(old.id)) variants.push({ ...old, active: false });
    }
    proposedPackages.set(selected.entryId,{ ...canonicalProduct(product,selected), itemIds, variants });
    bindings.push(Object.freeze({ kind: 'package', entryId: selected.entryId, sourceId: selected.sourceId,
      variants: Object.freeze(selected.variants.map((entry) => Object.freeze({ entryId: entry.entryId, sourceId: entry.sourceId }))) }));
  }
  let next;
  try {
    next = normalizeTenantCatalogue({ ...catalogue, cateringItems: [...proposedItems.values()],
      cateringPackages: [...proposedPackages.values()] });
  } catch { invalid('CATERING_CATALOGUE_PUBLICATION_CATALOGUE_CONFLICT'); }
  const assignments = normalizeCateringCatalogueAssignments({ schemaVersion: 1, catalogueRevision: catalogueRevision + 1,
    assignments: [...owners].map(([identifier,integration]) => {
      const colon = identifier.indexOf(':');
      return { kind: identifier.slice(0,colon), entryId: identifier.slice(colon+1), integrationId: integration };
    }) }, { tenantId, catalogueRevision: catalogueRevision + 1, catalogue: next, connections: expected.connections });
  return Object.freeze({ schemaVersion: 1, commandId, tenantId, integrationId, sourceRevision, configurationRevision,
    catalogueRevision: catalogueRevision + 1, assignmentRevision: assignmentRevision + 1, publicationRevision: publicationRevision + 1,
    catalogue: next, assignments: assignments.assignments, bindings: Object.freeze(bindings.sort((left,right) =>
      key(left.kind,left.entryId) < key(right.kind,right.entryId) ? -1 : 1)) });
}

// A rejection retains the last publication and carries no proposed replacement.
// Review intent still binds every observed version; no body field is authority.
export function normalizeCateringCatalogueReviewCommand(value) {
  record(value, ['schemaVersion','commandId','expectedReviewRevision','expectedSourceRevision','expectedConfigurationRevision',
    'expectedCatalogueRevision','expectedAssignmentRevision','expectedPublicationRevision','decision','justification','items','packages']);
  if (!['published','rejected'].includes(value.decision) || typeof value.justification !== 'string'
    || !value.justification.isWellFormed()
    || /[<>\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/.test(value.justification)) invalid();
  const justification = value.justification.trim().normalize('NFC'); if (!justification.length || justification.length > 1000) invalid();
  const command = normalizeCateringCataloguePublicationCommand({ schemaVersion: value.schemaVersion,commandId: value.commandId,
    expectedSourceRevision: value.expectedSourceRevision,expectedConfigurationRevision: value.expectedConfigurationRevision,
    expectedCatalogueRevision: value.expectedCatalogueRevision,expectedAssignmentRevision: value.expectedAssignmentRevision,
    expectedPublicationRevision: value.expectedPublicationRevision,items: value.items,packages: value.packages });
  if (value.decision === 'rejected' && (command.items.length !== 0 || command.packages.length !== 0)) invalid();
  return Object.freeze({ ...command,expectedReviewRevision: revision(value.expectedReviewRevision,0),
    decision: value.decision,justification });
}
