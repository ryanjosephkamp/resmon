import { useEffect, type RefObject } from 'react';
import { SECTIONS, SETTINGS } from '../routes';
import { Icon } from './Icon';
import { COMMAND_ENTER_CHORD, FIND_CHORD, keysText, sectionIndex, SHORTCUTS, type Shortcut, type ShortcutId } from './shortcuts';

/** What each shortcut does, in the words the sheet uses. Sections are named from the route table. */
const SAYS: Partial<Record<ShortcutId, string>> = {
  palette: 'Search commands',
  shortcuts: 'Keyboard shortcuts',
  'new-conversation': 'New conversation, in Ask',
  'new-dive': 'New Deep Dive',
  'new-sweep': 'New Deep Sweep',
  ask: 'Message the assistant',
  settings: SETTINGS.label,
  back: 'Back',
  forward: 'Forward',
};

/** Two columns of groups, about as long as each other. */
const COLUMNS: readonly (readonly { title: string; ids: readonly ShortcutId[] }[])[] = [
  [
    { title: 'Start', ids: ['new-dive', 'new-sweep', 'new-conversation', 'ask'] },
    { title: 'Back and forward', ids: ['back', 'forward'] },
    { title: 'Reading a file', ids: [] },
  ],
  [
    { title: 'Go to', ids: ['section-1', 'section-2', 'section-3', 'section-4', 'section-5', 'section-6', 'settings'] },
    { title: 'Anywhere', ids: ['palette', 'shortcuts'] },
  ],
];

/** The words for a shortcut: what it does, from the table above or the section it opens. */
export function shortcutWords(id: ShortcutId): string {
  const index = sectionIndex(id);
  return index === null ? SAYS[id] ?? id : SECTIONS[index]?.label ?? id;
}

function Keys({ shortcut, mac }: { shortcut: Shortcut; mac: boolean }) {
  const also = shortcut.also?.[mac ? 'mac' : 'other'];
  return (
    <dd>
      <kbd>{keysText(shortcut.chord, mac)}</kbd>
      {also && <><span className="keys-or">or</span><kbd>{keysText(also, mac)}</kbd></>}
    </dd>
  );
}

/**
 * Keyboard shortcuts: every key the shell answers, in this platform's own
 * names, from the same table the shell matches keys against. Opened with `?`,
 * from the command palette, from Settings › About resmon, and from the Help
 * menu. A modal of the shell's own, as the palette is: a shortcut pressed
 * while it is open closes it and does what it says.
 */
export function ShortcutsSheet({ open, onClose, dialog, mac }: {
  open: boolean;
  onClose: () => void;
  dialog: RefObject<HTMLDialogElement | null>;
  mac: boolean;
}) {
  useEffect(() => {
    const node = dialog.current;
    if (!node) return;
    if (open && !node.open) node.showModal();
    else if (!open && node.open) node.close();
  }, [open, dialog]);

  return (
    <dialog
      ref={dialog}
      className="keys-sheet"
      data-shell-dialog=""
      aria-labelledby="keys-title"
      // A close event is queued: one that arrives after the sheet was opened again is not this opening's.
      onClose={() => { if (!dialog.current?.open) onClose(); }}
      onCancel={onClose}
      onMouseDown={(event) => { if (event.target === dialog.current) onClose(); }}
    >
      <div className="keys-head">
        <h2 id="keys-title" className="keys-title">Keyboard shortcuts</h2>
        <button type="button" className="iconbtn" aria-label="Close" onClick={onClose}><Icon name="close" /></button>
      </div>
      <div className="keys-groups">
        {COLUMNS.map((column) => (
          <div key={column[0]?.title} className="keys-column">
            {column.map((group) => (
              <section key={group.title} className="keys-group" aria-label={group.title}>
                <h3 className="keys-group-title">{group.title}</h3>
                <dl className="keys-list">
                  {group.ids.map((id) => {
                    const found = SHORTCUTS.find((s) => s.id === id);
                    return found && (
                      <div key={id} data-shortcut={id}>
                        <dt>{shortcutWords(id)}</dt>
                        <Keys shortcut={found} mac={mac} />
                      </div>
                    );
                  })}
                  {group.title === 'Anywhere' && (
                    <div data-shortcut="command-enter">
                      <dt>Save or send what you wrote</dt>
                      <dd><kbd>{keysText(COMMAND_ENTER_CHORD, mac)}</kbd></dd>
                    </div>
                  )}
                  {group.title === 'Reading a file' && (
                    <div data-shortcut="find">
                      <dt>Find in the file</dt>
                      <dd><kbd>{keysText(FIND_CHORD, mac)}</kbd></dd>
                    </div>
                  )}
                  {group.title === 'Back and forward' && (
                    <div data-shortcut="swipe">
                      <dt>On a trackpad</dt>
                      <dd className="keys-words">Two fingers: swipe right for back, left for forward</dd>
                    </div>
                  )}
                </dl>
              </section>
            ))}
          </div>
        ))}
      </div>
      <p className="keys-note">
        {mac ? 'The ⌘ shortcuts' : 'The Ctrl shortcuts'} work while you type in a field too; ? does not, since there it
        types a question mark. None works while another dialog is open.
        {mac && ' A two-finger swipe follows Swipe between pages, in System Settings › Trackpad › More Gestures.'}
      </p>
    </dialog>
  );
}
