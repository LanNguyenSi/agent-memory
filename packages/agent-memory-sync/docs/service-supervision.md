# Running `watch` under a supervisor

Deep-dive on `watch`'s restart accounting under systemd, and the macOS
launchd equivalent. See the [README](../README.md#systemd-unit) for the
sample unit file and [Sync behavior](sync-behavior.md) for the
queue-vs-crash distinction this section relies on.

## Which failures count against the restart budget

`watch`'s push goes through the same base-snapshot-aware `performPush`
that `run`'s `pull`/`push`/`sync` use (`src/memory-sync/push.ts`), so it
gets the same reachability precheck and offline-queue behavior described
in [Sync behavior](sync-behavior.md): an unreachable remote, or a push the
remote rejects (auth, non-fast-forward, network), is queued locally
(`stateDir/queue`) and replayed on the next successful `watch` tick or
`run`, with a clean exit `0`. This is a deliberate contract: an earlier
version of `watch` exited non-zero on any push failure and relied on
launchd/systemd to restart the process.

The queue-instead-of-crash handling is narrow: only a failure that
`GitClient.lookupRemoteHead` / `GitClient.push` attributes to the remote
itself (unreachable, rejected, non-fast-forward, see
`RemoteUnavailableError` in `src/errors.ts`) is queued. Every other
failure still exits non-zero and reaches the supervisor-restart path
below: a config/data error raised before the remote working copy is even
prepared (e.g. a required `syncPaths` entry missing), and any other
git-level failure while that working copy is being prepared or committed
(a full disk, a corrupted git config, a broken commit hook, ...).

Exit semantics are unchanged by conflict handling: a conflict exits `0`
(it is visible only through `conflicts=N` and the notes), and the
mass-delete guard (exit `5`) keeps the watcher ticking. A watch tick whose
only outcome is held-back conflicts logs them
(`watch tick produced no remote changes; N conflict(s) held back: <paths>`)
instead of staying silent.

`watch` still never pulls; it is edge-triggered on local changes only, so
a machine that was offline while changes landed elsewhere will not pick
them up until its own next local edit. For that reason, a periodic `run
--mode sync` running alongside `watch` is a required part of any
fallback-machine setup; see [docs/machine-setup.md](machine-setup.md) for
the launchd/systemd companion jobs.

## Restart-loop budget

`StartLimitIntervalSec` / `StartLimitBurst` cap systemd's restart loop for
the failures that still exit non-zero, so a persistently broken cause does
not crashloop forever. The one exception is [queue escalation](sync-behavior.md#queue-escalation):
once the queue has been failing to drain past `queueEscalationThresholdMs`
(default 24h), a tick DOES exit non-zero again, but only on a real local
edit (`watch` is edge-triggered), so it does not spend this budget any
faster than this machine's memory actually changes while the remote stays
broken. Inspect `journalctl -u agent-memory-sync-watch.service` for the
`snapshot push failed: ...` line `watch` writes to stderr before exiting
on one of those failures.

Honest arithmetic, measured: one crash-restart cycle (a failed start plus
`RestartSec`) is about 11s. Under a `StartLimitBurst=10` /
`StartLimitIntervalSec=300` pairing, 10 crashes exhaust the budget in
about 110s, well inside a single ordinary "edit the config, restart,
still broken, edit again" debugging session. Once the burst is exhausted,
systemd does not just pause the restart loop, it marks the unit `failed`
and stops trying entirely, even after the underlying cause is fixed,
until the failure counter is explicitly cleared:

```bash
systemctl reset-failed agent-memory-sync-watch.service
systemctl restart agent-memory-sync-watch.service   # reset-failed only clears the counter, it does not start the unit
```

The sample unit in the [README](../README.md#systemd-unit) raises the
pairing to `StartLimitIntervalSec=1800` / `StartLimitBurst=30` (about 30
crashes x 11s = 330s, under 6 minutes of continuous crash-looping) so
ordinary iterative config editing has realistic headroom before landing
in `failed`, while a genuinely broken cause still gets capped well short
of looping forever.

## macOS equivalent

See [`docs/launchd/com.agent-memory-sync.watch.plist.template`](launchd/com.agent-memory-sync.watch.plist.template)
and [docs/machine-setup.md](machine-setup.md). macOS's `ThrottleInterval`
is not a direct analogue of the systemd pairing above: it only enforces a
minimum gap between respawns and has no burst counter or give-up state at
all, so a broken `watch` LaunchAgent keeps retrying indefinitely instead
of ever reaching a terminal `failed` state that needs a manual reset.
