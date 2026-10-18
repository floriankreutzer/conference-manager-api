import { runProviderWatchDelivery } from './support/provider-watch-delivery.mjs';
import { createProviderWatchMailbox } from './support/provider-watch-mailbox.mjs';

// Private JSON-lines RPC to native connector tools. No HTTP client, account configuration or mail credentials.
// The first input is {warning,policy}; subsequent inputs are exact {id,ok,value} replies, one per request.
const MAX_LINE_BYTES = 524_288;
let buffer = Buffer.alloc(0);
let waiting = null;
let ended = false;
let sequence = 0;
let mailbox;

function fail() {
  process.stderr.write('PROVIDER_WATCH_FAILED\n');
  process.exit(1);
}

process.stdin.on('error', fail);
process.stdout.on('error', fail);
process.stdin.on('end', () => {
  ended = true;
  if (waiting) { waiting.reject(new Error('CLOSED')); waiting = null; }
});
process.stdin.on('data', (chunk) => {
  buffer = Buffer.concat([buffer, chunk]);
  if (buffer.length > MAX_LINE_BYTES) fail();
  drain();
});

function drain() {
  if (!waiting) return;
  const index = buffer.indexOf(10);
  if (index < 0) return;
  const line = buffer.subarray(0, index); buffer = buffer.subarray(index + 1);
  const pending = waiting; waiting = null;
  try { pending.resolve(JSON.parse(line.toString('utf8'))); } catch { pending.reject(new Error('INVALID')); }
}

function nextLine() {
  return new Promise((resolve, reject) => {
    if (ended) { reject(new Error('CLOSED')); return; }
    waiting = { resolve, reject }; drain();
  });
}

async function rpc(operation, args = null) {
  sequence += 1;
  if (sequence > 12) throw new Error('BOUNDED');
  const request = { id: sequence, operation, args };
  if (mailbox) await mailbox.write(`${sequence}-request.json`, request);
  else process.stdout.write(`${JSON.stringify(request)}\n`);
  const reply = mailbox ? await mailbox.read(`${sequence}-response.json`) : await nextLine();
  if (!reply || Object.keys(reply).length !== 3 || reply.id !== sequence || reply.ok !== true
    || !Object.hasOwn(reply, 'value')) throw new Error('PORT_FAILED');
  return reply.value;
}

const timeout = setTimeout(fail, 600_000);
try {
  if (process.argv.length !== 2) {
    if (process.argv.length !== 4 || process.argv[2] !== '--mailbox') throw new Error('INPUT');
    mailbox = await createProviderWatchMailbox(process.argv[3]);
  }
  const init = mailbox ? await mailbox.read('init.json') : await nextLine();
  if (!init || Object.keys(init).length !== 2 || !Object.hasOwn(init, 'warning') || !Object.hasOwn(init, 'policy')) {
    throw new Error('INPUT');
  }
  const result = await runProviderWatchDelivery({ ...init, clock: () => Date.now(),
    ledger: { read: () => rpc('ledger.read'), write: (args) => rpc('ledger.write', args) },
    transport: { send: (args) => rpc('transport.send', args), lookup: (sendId) => rpc('transport.lookup', { sendId }) },
  });
  if (mailbox) await mailbox.write('complete.json', { operation: 'complete', result });
  else process.stdout.write(`${JSON.stringify({ operation: 'complete', result })}\n`);
  clearTimeout(timeout);
  process.stdin.destroy();
} catch { fail(); }
