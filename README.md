# dsh-sidechat

`dsh-sidechat` is an independent plugin for [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness). It provides a read-only slash command that explains an Agent's committed trajectory without starting or steering a parent Agent turn.

The current version implements:

- installation as an out-of-tree DSH bundle;
- privacy-preserving observation of committed `session/event` metadata;
- immutable snapshots through the latest authoritative `turn/end` boundary;
- exact reconstruction of the model-visible message surface at that boundary;
- `/sidechat` snapshot inspection through DSH's native command catalog;
- `/sidechat <question>` as a native one-shot DSH fork subagent;
- an isolated SideChat persona over the parent's latest completed-turn prefix;
- an empty child tool allowlist for the initial strictly read-only version;
- native DSH subagent transcripts, status, timing, cancellation, and Web navigation;
- `/sidechat cancel [<request-id>]` for active SideChat children.

It does not yet provide a separate SideChat panel, multi-turn SideChat conversations, promotion into the parent Agent, or a plugin-owned persistence format.

## Use

In a DSH Web conversation, enter:

```text
/sidechat
```

The command reports the parent session id, latest completed turn, stable event boundary, event count, model-visible message count, and active SideChat count. It does not call an LLM.

Ask one isolated question with:

```text
/sidechat Why did the Agent choose this approach?
```

The command returns after DSH publishes the child, without waiting for its model turn to finish. The main chat can immediately continue. Open the subagent list in the parent conversation header to watch the SideChat transcript, reasoning, terminal status, and token usage. The child uses the parent's latest provider/model route and DSH's `fork` provider, whose seed ends at the last completed parent turn. An active parent turn is excluded.

The initial observer child receives an empty global tool allowlist. It can explain committed conversation history but cannot inspect the live parent turn, list the parent's sibling subagents, modify files, run commands, or steer another agent. Parent-bound read-only inspection tools are intentionally deferred instead of exposing the ordinary `list_agents` tool, which would list the SideChat child's own descendants.

Cancel the newest request, or one shown request id, with:

```text
/sidechat cancel
/sidechat cancel 12ab34cd
```

## Architecture

```mermaid
flowchart LR
    U[/sidechat or /sidechat question] --> C[DSH Command Registry]
    DSH[DeepSeek Harness] -->|committed session/event| O[SideChat Observer]
    O -->|session id + seq + type| L[Host log]
    C -->|current Agent session id| S[Stable Snapshot Service]
    DSH -->|read event prefix| S
    S -->|metadata| R[Snapshot Command Result]
    S -->|boundary validation| Q[Native fork Subagent]
    Q -->|publish child id| A[Immediate Command Receipt]
    A -->|composer unlocks| P[Parent Agent]
    Q -->|own Agent loop| T[Read-only SideChat Transcript]
    T --> W[Native DSH Subagent UI]
    O -. no parent changes .-> P
    S -. no parent changes .-> P
    Q -. empty tool allowlist; no parent steering .-> P
```

The observer receives events only after DSH appends them to the session log. The snapshot service finds the latest `turn/end`, copies only that closed prefix, and folds it with DSH's canonical surface rules. A turn that is still running is excluded. Existing snapshots are detached and frozen, so later parent activity cannot change them. SideChat never calls `agent.steer()` or `agent.followup()` on the parent.

DSH's command runtime records the standard log-only `command/run` and `command/done` lifecycle around every slash command. SideChat sets `recordInput: false`, so the private question is absent from the parent command record. It delegates through `ctx.subagents.start('fork', ...)` with a dedicated persona and `{ allow: [] }` tool restriction. DSH owns the child session, full Agent loop, lifecycle events, persistence, and native Web transcript. The plugin owns the returned one-shot run, disposes it after settlement, and aborts and awaits active children during unload.

The host-side API is available as:

```ts
const snapshot = ctx.sideChatSnapshots.capture(sessionId)
```

`snapshot.events` contains the canonical prefix and `snapshot.messages` contains the exact model-visible surface reconstructed from that prefix. Before the first `turn/end`, both arrays are empty and `boundarySeq` is `null`.

## Requirements

- Node.js `^22.19.0` or `>=24`
- pnpm
- DeepSeek Harness `0.1.0-rc.7` or a compatible developer-preview build

## Develop

```powershell
pnpm install
pnpm run check
```

## Load from a local checkout

From the DeepSeek Harness checkout:

```powershell
pnpm dsh plugin --profile web add "C:\src\dsh-sidechat"
pnpm dsh web
```

After cloning or installing directly from GitHub, use:

```powershell
pnpm dsh plugin --profile web add github:Glaz-j/dsh-sidechat
```

Git dependencies build through the package's `prepare` script. pnpm 10 and newer may stop the first installation and print the exact codeload package key that must be added under `allowBuilds` in the profile's `pnpm-workspace.yaml`. Copy that key verbatim, set it to `true`, and repeat the installation command.

The host prints:

```text
[dsh-sidechat] plugin loaded (native observer subagent)
```

Committed session activity produces metadata-only lines such as:

```text
[dsh-sidechat] session=<id> seq=12 event=tool/result
```

Remove the bundle with:

```powershell
pnpm dsh plugin --profile web remove dsh-sidechat
```

Maintainers with a local Harness checkout can run the isolated Loader smoke test by setting `DSH_HARNESS_ROOT`, then running `pnpm smoke:dsh`. The script boots a real in-process Agent Loop with DSH's actual `fork` provider, loads the built bundle, verifies native child lineage, completed-turn inheritance, observer persona and tool restriction, confirms question privacy and settlement, and disposes the tree.

## Configuration

The bundle inserts this default row:

```yaml
- id: sidechat-observer
  name: dsh-sidechat
  config:
    observeEvents: true
    eventTypes: []
    subagentProvider: fork
```

An empty `eventTypes` list observes every committed event type. Set an exact allowlist to reduce noise:

```yaml
eventTypes:
  - turn/start
  - step/start
  - tool/call
  - tool/result
  - step/end
  - turn/end
```

Set `observeEvents: false` to keep only lifecycle proof.

`subagentProvider` must name a provider that inherits parent context and supports both `persona` and `toolFilter`. DSH Web ships the compatible `fork` provider used by default.

## Roadmap

1. Complete: stable snapshot at the last closed turn.
2. Complete: native one-shot fork observer through `/sidechat <question>`.
3. Parent-bound read-only status and event-query tools.
4. Ephemeral multi-turn SideChat with disposal.
5. Live committed-event snapshots.
6. Explicit discard and follow-up promotion.

## License

[MIT](LICENSE)
