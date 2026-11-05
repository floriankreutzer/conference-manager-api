import { pathToFileURL } from 'node:url';
import { collectGithubPrInventory } from './jira-github-inventory.mjs';

/** Reports counts only: never publish private PR titles, refs, bodies or tokens. */
export async function runInventoryDiagnostic({ token, fetchImpl, write = console.log } = {}) {
  try {
    const inventory = await collectGithubPrInventory({ token, fetchImpl });
    write(JSON.stringify({ schemaVersion: 1, result: 'INVENTORY_ENUMERATED',
      readinessEvaluated: false,
      repositories: inventory.inventories.map(({ repository, count }) => ({ repository, count })) }));
    return 0;
  } catch {
    write(JSON.stringify({ schemaVersion: 1, result: 'GITHUB_INVENTORY_UNVERIFIED', readinessEvaluated: false }));
    return 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = await runInventoryDiagnostic({ token: process.env.CM_GITHUB_INVENTORY_TOKEN });
}
