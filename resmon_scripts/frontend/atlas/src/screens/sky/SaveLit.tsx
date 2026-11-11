import type { Sky } from '../today/model';
import { count } from '../today/format';
import { SaveButton, SaveLimit, useSaveToRead } from '../library/SaveMany';
import type { Look } from './look';

/** The papers a look lights on a sky, by id: the find's matches while there is a find, else the ones the filters leave lit. */
export function litIds(sky: Sky, look: Look, finding: boolean): number[] {
  const out: number[] = [];
  if (finding) {
    for (const i of look.found) { const id = sky.ids[i]; if (id !== undefined) out.push(id); }
    return out;
  }
  if (!look.lit) return out;
  for (let i = 0; i < sky.count; i++) if (look.lit[i]) { const id = sky.ids[i]; if (id !== undefined) out.push(id); }
  return out;
}

/**
 * Save what a map is showing to read: the papers a find or the filters leave
 * lit, the number its bar says, and nothing the map dims. Offered only while
 * something is dimmed, since a map that lights every paper is the whole
 * collection (or the whole run), which Search › Collection saves.
 */
export function SaveLit({ sky, look, finding, waiting }: { sky: Sky; look: Look | null; finding: boolean; waiting: boolean }) {
  const saving = useSaveToRead();
  // While a find or the filters are being read, the count beside it is not said, so neither is this.
  if (!look || look.waiting || waiting || look.lit === null) return saving.notice ? <>{saving.notice}</> : null;
  const n = look.shown;
  const what = finding ? `the ${count(n, 'paper')} the find matches` : `the ${count(n, 'paper')} the filters leave lit`;
  return (
    <>
      {n > 0 && (
        <div className="map-save" data-map-save={n}
          title={finding ? 'The papers the find matches, as the map lights them' : 'The papers the filters leave lit'}>
          <SaveButton n={n} all={false} busy={saving.pending || saving.asking} saving={saving.pending}
            onSave={() => saving.save({ target: { kind: 'listed', ids: litIds(sky, look, finding) }, n, all: false, what })} />
        </div>
      )}
      <SaveLimit n={n} />
      {saving.question}
      {saving.refused}
      {saving.notice}
    </>
  );
}
