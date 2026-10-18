# Connector warning delivery

## One executable protocol

`scripts/support/provider-watch-delivery.mjs` owns pending reservation, exact payload and event
binding, the bounded retry window, receipt reconciliation and atomic finalization of warning
acknowledgements. `scripts/provider-watch-delivery.mjs` runs that same function over private
JSON-lines ports to native connector tools. Tests import the function and kill/restart the actual
CLI; there is no second state machine or test-only sender. No server runtime imports this tool.

The operator automation must be bound to the accepted immutable source before this is claimed as
its active implementation. Source tests, merged source, configured binding, actual no-signal
execution, fixture transport crashes and real-provider failure/idempotency are distinct evidence.
The withdrawn PR193 model is not used. This document alone claims none of the operational gates.

## Native connector bridge

Fetch this CLI and its two support modules from the same accepted full API commit into a private
temporary directory, preserving relative paths. Do not install dependencies. Run Node22 or newer
as `node scripts/provider-watch-delivery.mjs` with an interactive stdin/stdout session. Do not put
private input in command arguments, source control or public logs. Input/output is private IPC,
not a public diagnostic report. The process has a ten-minute lifetime, bounded lines and at most
twelve port requests. On failure, stderr is only `PROVIDER_WATCH_FAILED`; never echo tool errors.

For hosts without persistent subprocess stdin, use `node scripts/provider-watch-delivery.mjs
--mailbox /private/temporary-directory`. The supplied directory must belong to the current OS
user with mode0700; files must be regular, user-owned mode0600 files. Symlink files are rejected.
Write init.json, then respond to each numbered N-request.json with N-response.json, each containing
the identical RPC envelope described below. Publish responses atomically by writing a private
temporary file and renaming. The process emits no private payload on stdout in mailbox mode;
complete.json carries its result. Names are fixed; no provider/ledger data selects a path. Do not
reuse a directory between sessions or retain IPC files after the minimized result is verified.

Send one initial JSON line with exactly `warning` and `policy`. Policy has exactly `from`, `to`
(one address string), `subject`, all taken from the existing approved private watch configuration.
Warning is `null` when there is no new validated signal or when resuming an existing pending
attempt. Otherwise it has exactly `idempotencyKey`, `payload`, `acknowledgements`. Payload is
exactly `{from,to:[address],subject,text}`, matching policy and with at most16,384 text characters.
There are no HTML, CC/BCC, attachments, arbitrary headers, URLs or credentials in this interface.
The existing collector owns source validation, threshold evaluation and deterministic logical key
selection; this module does not add a competing collector or change source limits.

Each acknowledgement has exactly `source` (`neon`, `resend.daily` or `resend.monthly`), `windowEnd`
(original canonical UTC provider period end/reset time) and sorted unique `thresholds` from
50/70/85/95. Supply the validated new real levels only. The pending event binds these facts as well
as the exact payload. New reservations require matching current ledger windows. At finalization,
only still-matching windows are acknowledged, so recovery cannot pollute a subsequent period.

For each output `{id,operation,args}`, perform ONLY the corresponding approved native action,
then reply on stdin with exactly `{id,ok:true,value}` using the same ID. A failed/uncertain native
operation gets `{id,ok:false,value:null}`; stop, retain durable state and report a minimized error.
Never retry a side effect within a session. Never fabricate success or replace a failed operation.

| Operation | Required adapter behavior and response value |
| --- | --- |
| `ledger.read` | Fresh authenticated read of the existing approved private draft; verify owner/status and exactly one schema-v1 machine block. Return that entire parsed machine object. Do not read a credentials page. |
| `ledger.write` | Args are complete `expected` and `next` machine snapshots. Freshly re-read/verify draft+owner and compare the machine object to `expected`. Under exclusive watch execution replace only its machine code block with `next`, preserving all page prose/other blocks and draft status. Reject a concurrent change, unavailable concurrency protection, or write failure. Return null; the runner independently requests the subsequent readback. |
| `transport.send` | Recheck remaining approved daily/monthly send capacity; send once via the existing Resend connector using exactly the command's idempotencyKey/from/to/subject/text. Return only `{sendId}` from the actual accepted provider result. Preserve the existing private conversation context. No recipient fallback or extra test message. |
| `transport.lookup` | Read the actual provider receipt identified by args.sendId; validate its identity, normalize only known states to accepted/delivered/failed/bounced/delayed, and return exactly `{sendId,status}`. Unknown/unsupported/pending responses fail the port and leave pending intact. |

An output `{operation:"complete",result}` ends the session. Keep only minimized action/status and
source commit in private evidence; no raw IPC or warning body in public artifacts. The normal
collector may update its observations before entering the protocol, but it must not run another
ledger writer during this session. No parallel manual send or overlapping execution is supported.
The bridge needs exclusive execution and a protected compare/write; pre-read alone is not a
distributed lock or compare-and-swap guarantee. If the connector cannot provide this, fail closed
and leave delivery pending rather than claiming concurrency safety or bypassing the protocol.

## State and recovery

The complete existing schema-v1 machine object is preserved. Only pending, appended deliveries
and matching acknowledged thresholds are changed. New pending entries carry protocolVersion1,
the exact event, canonical payload SHA-256, whole-event SHA-256, original createdAt and sendId.
Canonical payload hashing uses JSON.stringify in from/to/subject/text order and UTF-8; event
hashing also binds key and acknowledgements. Completed protocol receipts retain both digests,
key, original clock, sendId and truthful status, but omit the message body.

Historical receipts remain byte-semantically unchanged, suppress their existing key and return
`legacy_receipt` without asserting digest equality. Historical pending structures require manual
reconciliation; no guessed digest, automatic migration or blind legacy retry is performed. Unknown
protocol versions are not accepted as current records. No existing receipt is evicted to make room:
at50receipts, new reservation fails closed and needs a separately reviewed retention policy.

The original pending payload/key is reused after uncertain acceptance. Unknown attempts stop at
the exact24h boundary, rechecked after asynchronous readback immediately before sending. A known
sendId may be looked up after24h without sending. Provider acceptance and delivery are distinct;
accepted/failed/bounced/delayed never masquerade as delivered or trigger a second warning. Final
receipt and applicable reported thresholds are one ledger mutation, independently read back.

Process-kill tests use durable local fixture files and provider-port receipts; they establish the
executed protocol/IPC recovery behavior, not provider retention, real Resend fault handling,
Confluence power-loss durability, distributed locking or exactly-once delivery. Actual live
transport fault acceptance remains separately governed in app issue263. No new email or spend
is authorized by running a fixture or a no-signal production bridge read.
