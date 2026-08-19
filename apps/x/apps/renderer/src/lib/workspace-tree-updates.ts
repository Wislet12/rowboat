export type WorkspaceTreeEntry = {
  path: string
  stat?: { size: number; mtimeMs: number }
  children?: WorkspaceTreeEntry[]
}

/**
 * Content-only writes do not change the directory topology. Patch just the
 * matching mtime so high-frequency meeting checkpoints do not recursively
 * re-read and rebuild the entire Brain tree on the renderer thread.
 */
export function touchWorkspaceTree<T extends WorkspaceTreeEntry>(
  nodes: T[],
  changedPaths: ReadonlySet<string>,
  mtimeMs: number,
): T[] {
  let changed = false
  const next = nodes.map((node) => {
    let nextNode = node
    if (changedPaths.has(node.path)) {
      changed = true
      nextNode = {
        ...nextNode,
        stat: { size: nextNode.stat?.size ?? 0, mtimeMs },
      }
    }
    if (node.children?.length) {
      const nextChildren = touchWorkspaceTree(node.children, changedPaths, mtimeMs)
      if (nextChildren !== node.children) {
        changed = true
        nextNode = { ...nextNode, children: nextChildren }
      }
    }
    return nextNode
  })
  return changed ? next : nodes
}
