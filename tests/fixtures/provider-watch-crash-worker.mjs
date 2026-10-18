import { readFile, writeFile, rename } from 'node:fs/promises';
import path from 'node:path';
import { runIsolatedProviderWatchAttempt } from '../../scripts/provider-watch-delivery-model.mjs';

// Synthetic local files only. There is deliberately no email, URL, credential or network adapter.
const [directory, fault] = process.argv.slice(2);
if (process.argv.length !== 4 || !['none', 'after_provider_acceptance', 'after_receipt_write'].includes(fault)) {
  throw new Error('PROVIDER_WATCH_FIXTURE_INPUT_INVALID');
}
const statePath = path.join(directory, 'ledger.json');
const receiptsPath = path.join(directory, 'receipts.json');
const read = async (filename) => JSON.parse(await readFile(filename, 'utf8'));
const atomicWrite = async (filename, value) => {
  await writeFile(`${filename}.next`, JSON.stringify(value), { mode: 0o600 });
  await rename(`${filename}.next`, filename);
};
const event = { key: 'fixture-threshold-95', digest: 'a'.repeat(64) };
await runIsolatedProviderWatchAttempt({
  event,
  clock: () => Date.parse('2026-10-18T12:00:00.000Z'),
  ledger: {
    read: () => read(statePath),
    async write(value) {
      await atomicWrite(statePath, value);
      if (fault === 'after_receipt_write' && value.pending?.sendId) process.exit(74);
    },
  },
  transport: {
    async send(pending) {
      const receipts = await read(receiptsPath);
      let receipt = receipts.find((item) => item.key === pending.key);
      if (!receipt) {
        receipt = { key: pending.key, digest: pending.digest, sendId: 'fixture-receipt-1' };
        receipts.push(receipt);
        await atomicWrite(receiptsPath, receipts);
      }
      if (receipt.digest !== pending.digest) throw new Error('PROVIDER_WATCH_FIXTURE_PAYLOAD_MISMATCH');
      if (fault === 'after_provider_acceptance') process.exit(73);
      return { sendId: receipt.sendId };
    },
    async lookup(sendId) {
      const receipts = await read(receiptsPath);
      if (!receipts.some((item) => item.sendId === sendId)) throw new Error('PROVIDER_WATCH_FIXTURE_RECEIPT_MISSING');
      return { sendId, status: 'delivered' };
    },
  },
});
