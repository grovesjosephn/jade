/**
 * Reading jade's JSON whichever version printed it. jade 0.4 calls the list
 * `workspaces`; earlier versions call it `groups`. jade 0.4 still prints both,
 * and an older jade on PATH prints only `groups`, so read the new name first.
 */
export function workspacesOf<T>(json: unknown): T[] {
  const j = (json ?? {}) as { workspaces?: T[]; groups?: T[] };
  return j.workspaces ?? j.groups ?? [];
}
