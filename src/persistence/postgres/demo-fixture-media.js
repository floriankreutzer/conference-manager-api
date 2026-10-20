// Compatibility exports: the closed Demo keeps its existing API and errors.
// These stateless byte/reference operations carry no Demo authority or reset.
export {
  forEachFixtureMediaBatch as forEachDemoMediaBatch,
  fixtureMediaReferences as demoFixtureMediaReferences,
  publishFixtureMedia as publishDemoFixtureMedia,
  readFixtureMediaBytes as readDemoFixtureMediaBytes,
} from './business-fixture-media.js';
