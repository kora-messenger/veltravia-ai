import { useAsyncResource } from '../../api/use-async-resource';
import { getWorkspaceTree, type FileTreeView } from '../../api/workspaces';
import { EmptyState, ErrorState, Spinner } from '../../components/ui';

/**
 * The workspace's real file tree (Step 11C-4): live structural metadata
 * from the Project Engine - relative paths and node types only, NEVER file
 * contents. Read-only context visualization: no editing, renaming, adding,
 * deleting, uploading, or drag/drop here.
 *
 * Depth indentation is a DISPLAY choice computed from the path the backend
 * already validated - the browser never constructs, normalizes, or sends
 * paths of its own.
 */
export function WorkspaceFileTree({ workspaceId }: { workspaceId: string | null }) {
  const resource = useAsyncResource(
    async () => (workspaceId === null ? [] : getWorkspaceTree(workspaceId)),
    [workspaceId],
  );

  if (workspaceId === null) {
    return <p className="v-context-empty">Files appear once this project has a workspace.</p>;
  }
  if (resource.state === 'loading') {
    return (
      <div className="v-context-loading" role="status">
        <Spinner size="sm" />
      </div>
    );
  }
  if (resource.state === 'error') {
    return (
      <ErrorState
        title="Files unavailable"
        description="The file tree could not be loaded right now."
        retry={{ onClick: resource.reload }}
      />
    );
  }
  const nodes = resource.data ?? [];
  if (nodes.length === 0) {
    return (
      <EmptyState title="No files yet" description="Files added to this workspace appear here." />
    );
  }

  // Backend-provided relative paths, sorted for a stable, readable order.
  const sorted = [...nodes].sort((left, right) => left.path.localeCompare(right.path));
  return (
    <ul className="v-context-files__tree" aria-label="Workspace files">
      {sorted.map((node) => (
        <FileTreeRow key={node.path} node={node} />
      ))}
    </ul>
  );
}

function FileTreeRow({ node }: { node: FileTreeView }) {
  // Display-only depth: counting path segments never mutates or re-sends
  // the path - it only indents the row.
  const depth = node.path.split('/').length - 1;
  return (
    <li
      className={`v-context-files__entry${
        node.type === 'directory' ? ' v-context-files__entry--folder' : ''
      }`}
      style={{ paddingLeft: `${depth * 14}px` }}
      title={node.path}
    >
      {node.type === 'directory' ? `${node.name}/` : node.name}
    </li>
  );
}
