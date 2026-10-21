# Native protected CI aggregate budget

The PostgreSQL integration job has a bounded20-minute total budget for the expanded protected runtime suite and its separate actual elapsed proof-expiry execution. Individual test deadlines, actual expiry intervals/clocks, assertions, rollback/cleanup and all required gates remain unchanged. Shared browser job budgets are unchanged. No paid runner or quota is selected.

Dated evidence21October2026: API284 actual-main378e1377/CI39611671378 native119263143465 completed the persistence and actual elapsed expiry tests, then cancelled during cleanup at the fifteen-minute aggregate limit. The targeted retry119274558881 also ended cancelled at that limit. Neither cancelled job is acceptance. This correction retains both failures and requires fresh complete native and every actual-main check; no successful step is promoted into a successful cancelled job.

API287 independently prepared the same bounded aggregate change for its added actual two-root browser bootstrap. This earlier main prerequisite now carries that budget so dependent main checks need no repeated speculative retries. SaaS1 tracking: https://github.com/floriankreutzer/conference-manager/issues/351. This is orchestration preparation, not deployment, physical-key, primary-Microsoft or mail evidence.
