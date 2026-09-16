# Editing a workflow export by hand

How to change an exported TradingGoose workflow outside the app — in an editor, or with a coding agent — without producing a file that imports cleanly and then does the wrong thing.

Point your agent at this file before it edits. `maki` picks it up if you drop it in the working directory or reference it from `MAKI.md`.

## The file

`Export` produces one JSON document:

```json
{
  "version": 1,
  "fileType": "tradingGooseExport",
  "resourceTypes": ["workflows", "skills"],
  "workflows": [{ "name": "...", "description": "...", "state": { ... } }],
  "skills": [{ "name": "...", "description": "...", "content": "..." }]
}
```

Everything below is about `workflows[0].state`:

| Field | Shape |
| --- | --- |
| `blocks` | object keyed by block id |
| `edges` | array — the execution graph |
| `loops`, `parallels` | containers, usually `{}` |
| `variables` | object keyed by variable id |

## Blocks

The key and the block's `id` are the same string. Ids are stable identities — **changing one is deleting a block and adding another**, and every edge that named it breaks.

```json
"guard": {
  "id": "guard",
  "type": "condition",
  "name": "Guard",
  "position": { "x": 0, "y": 0 },
  "enabled": true,
  "subBlocks": { "conditions": { "value": [ ... ] } }
}
```

`type` is what the block *is* and cannot be changed in place. `name` is the label, and other blocks reference it — `<agent.content>` resolves through the name, lowercased with spaces removed — so renaming means updating every reference.

## Edges — the part that matters

An edge is what makes a block run. Nothing else does.

```json
{ "source": "ag", "target": "jr", "id": "ag-source-jr-target", "type": "default", "data": {} }
```

`id` is conventionally `<source>-source-<target>-target`. It only has to be unique.

**A block with no incoming edge never executes.** It will not error. It will not appear in the logs. The run simply skips it, and you find out later from a result that never arrived. This is the single most common way a hand-edited workflow goes wrong, so after any edit, check every block is reachable from a trigger.

Text references do **not** create edges. A Journal block whose code reads `<agent.content>` still needs `agent → journal` in `edges`, or it never runs.

### Condition branches

A condition block declares its branches in `subBlocks.conditions.value`:

```json
[ { "id": "guard-if", "title": "if", "value": "<variable.killSwitch> === true" },
  { "id": "guard-else", "title": "else", "value": "" } ]
```

An edge leaving a branch sets `sourceHandle` to `condition-` plus that entry's `id`:

```json
{ "source": "guard", "sourceHandle": "condition-guard-if", "target": "jr", ... }
```

The handle must match a declared entry exactly. A wrong one leaves the branch unwired, and the workflow runs with that path going nowhere.

`conditions.value` is an array. It has been seen double-encoded as a JSON *string* containing the array; import accepts both, but write the array.

## Checklist before importing

1. Every block reachable from a trigger (`manual_trigger`, `schedule`, `webhook`, …).
2. Every `sourceHandle` starting `condition-` matches a declared branch id.
3. Every edge `source` and `target` names a block that exists.
4. Each branch ends somewhere deliberate — usually a `response`.
5. Block `id` and `type` unchanged for blocks that already existed.

Import enforces 1–3 and refuses the file with the block named. 4 comes back as a warning. 5 it cannot detect: a renamed id looks like a new block, and the old one silently disappears.

## Round trip

Export → edit → **Import**. Import validates and rejects a broken graph rather than accepting it, so a bad edit costs you an error message rather than a day of runs that quietly did nothing.
