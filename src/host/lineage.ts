/**
 * Subagent cascade selection.
 *
 * DSH lineage is `header.parentSession` plus `header.origin === 'subagent'`.
 * Ordinary forks may also carry a `parentSession` in published rc versions, so
 * the cascade must filter on `origin` — never on the parent pointer alone.
 *
 * @module dsh-session-butler/host/lineage
 */

import type { SessionLineageNodeLike, SessionLineageTraceLike, SessionRecordLike } from './ports.js'

/** Depth-first, parent-before-child flattening of subagent descendants. */
export function subagentDescendants(trace: SessionLineageTraceLike): SessionRecordLike[] {
  const selected: SessionRecordLike[] = []
  const visit = (nodes: readonly SessionLineageNodeLike[]): void => {
    for (const node of nodes) {
      if (node.session.header.origin === 'subagent') selected.push(node.session)
      visit(node.descendants)
    }
  }
  visit(trace.descendants)
  return selected
}
