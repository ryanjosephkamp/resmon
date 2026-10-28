/**
 * What a per-view fold hides, from the engine's preview
 * (`POST /api/links/collapse-preview`).
 *
 * The preview lists each group's members **including** the row the group is
 * kept as, keyed by that row's id. So the fold hides every member except the
 * key, and the kept row stands in for the rest. Reading every member as hidden
 * hid the kept row too, and a pair of the same work vanished from the list.
 */
export function foldedAway(folded: Record<string, readonly number[]>): Set<number> {
  const out = new Set<number>();
  for (const [root, members] of Object.entries(folded)) {
    for (const id of members) if (id !== Number(root)) out.add(id);
  }
  return out;
}

/** How many other records a kept row stands in for. */
export function standingInFor(folded: Record<string, readonly number[]>, id: number): number {
  return (folded[String(id)] ?? []).filter((member) => member !== id).length;
}
