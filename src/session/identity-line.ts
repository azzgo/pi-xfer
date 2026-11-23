/**
 * The **Identity line** (CONTEXT.md): the footer entry that carries this Node's
 * name and, when the mesh is configured, its Effective namespace. One composer,
 * so the three places that print it — the listener, a rename, a namespace
 * switch — can never disagree about what it says.
 *
 * It deliberately carries no online/offline fact: that belongs to
 * `/xfer mesh status`, one line per fact.
 */
export function identityLine(name: string, suffix = ""): string {
  return `📡 ${name}${suffix}`;
}
