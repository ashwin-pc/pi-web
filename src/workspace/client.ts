export type WorkspaceDescriptor = { id: string; name: string; root: string; runtime: "local" };

/** Cache descriptors, not session state. Failed authentication can be retried. */
export function createWorkspaceClient(headers: () => HeadersInit, sessionId: () => string) {
  const pending = new Map<string, Promise<WorkspaceDescriptor>>();
  return {
    async current() {
      const explicit = new URL(location.href).searchParams.get("workspaceId");
      const session = explicit ? "" : sessionId();
      const key = explicit || session;
      let result = pending.get(key);
      if (!result) {
        result = (async () => {
          const query = new URLSearchParams(session ? { sessionId: session } : {});
          const response = await fetch(`/api/workspaces?${query}`, { headers: headers() });
          if (!response.ok) throw new Error(`Could not load workspace (${response.status})`);
          const data = await response.json() as { current: WorkspaceDescriptor; workspaces: WorkspaceDescriptor[] };
          const workspace = explicit ? data.workspaces.find((item) => item.id === explicit) : data.current;
          if (!workspace) throw new Error("Workspace not found");
          return workspace;
        })();
        pending.set(key, result);
        result.catch(() => pending.delete(key));
      }
      return result;
    },
  };
}
