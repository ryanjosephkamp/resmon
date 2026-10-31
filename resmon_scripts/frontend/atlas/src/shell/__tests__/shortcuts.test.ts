import * as fs from 'fs';
import * as path from 'path';
import {
  MENU_COMMANDS, SHORTCUTS, ariaKeys, blockingDialogOpen, isMenuCommand, isTyping, keysText, sectionIndex, shortcut,
  shortcutFor, type KeyPress,
} from '../shortcuts';

const press = (key: string, held: Partial<Omit<KeyPress, 'key'>> = {}): KeyPress =>
  ({ key, metaKey: false, ctrlKey: false, altKey: false, shiftKey: false, ...held });
const mac = (key: string, held: Partial<Omit<KeyPress, 'key'>> = {}) => shortcutFor(press(key, { metaKey: true, ...held }), true)?.id ?? null;
const pc = (key: string, held: Partial<Omit<KeyPress, 'key'>> = {}) => shortcutFor(press(key, { ctrlKey: true, ...held }), false)?.id ?? null;

describe('each shortcut is one key with ⌘ on macOS and Ctrl elsewhere', () => {
  test('the set the shell answers', () => {
    expect(['k', 'n', 'd', '/', '1', '6', ',', '[', ']'].map((k) => mac(k)))
      .toEqual(['palette', 'new-conversation', 'new-dive', 'ask', 'section-1', 'section-6', 'settings', 'back', 'forward']);
    expect(mac('d', { shiftKey: true })).toBe('new-sweep');
    // With Shift held a letter may arrive capitalized.
    expect(mac('D', { shiftKey: true })).toBe('new-sweep');
    expect(['k', 'n', 'd', '/', '1', ',', '['].map((k) => pc(k)))
      .toEqual(['palette', 'new-conversation', 'new-dive', 'ask', 'section-1', 'settings', 'back']);
  });

  test('⌘W stays the window\'s, and nothing is taken that the menu or the editing keys already use', () => {
    for (const key of ['w', 'q', 'c', 'v', 'x', 'z', 'a', 'r', 'm', 'h', '0', '7', '9']) expect(mac(key)).toBeNull();
    expect(mac('d', { altKey: true })).toBeNull();
    expect(mac('n', { shiftKey: true })).toBeNull();
    // Ctrl is not ⌘ on macOS, and ⌘ is not Ctrl elsewhere.
    expect(shortcutFor(press('n', { ctrlKey: true }), true)).toBeNull();
    expect(shortcutFor(press('n', { metaKey: true }), false)).toBeNull();
    // Both held is a different chord.
    expect(mac('n', { ctrlKey: true })).toBeNull();
  });

  test('a digit is found by its key\'s position on a layout that types another character there', () => {
    expect(shortcutFor(press('&', { metaKey: true, code: 'Digit1' }), true)?.id).toBe('section-1');
    expect(shortcutFor(press('é', { ctrlKey: true, code: 'Digit2' }), false)?.id).toBe('section-2');
  });

  test('? is the one plain key, typed with Shift or without', () => {
    expect(shortcutFor(press('?', { shiftKey: true }), true)?.id).toBe('shortcuts');
    expect(shortcutFor(press('?'), false)?.id).toBe('shortcuts');
    expect(shortcutFor(press('/'), true)).toBeNull();
    expect(mac('?', { shiftKey: true })).toBeNull();
  });

  test('every shortcut has its own chord', () => {
    const chords = SHORTCUTS.map((s) => `${s.chord.command ? 'cmd+' : ''}${s.chord.shift ? 'shift+' : ''}${s.chord.key}`);
    expect(new Set(chords).size).toBe(chords.length);
  });

  test('the sections are the six digits, in order', () => {
    expect(SHORTCUTS.map((s) => sectionIndex(s.id)).filter((i) => i !== null)).toEqual([0, 1, 2, 3, 4, 5]);
    expect(sectionIndex('new-dive')).toBeNull();
  });
});

describe('the keys are written in the platform\'s own names', () => {
  test('macOS writes symbols, in Apple\'s order', () => {
    expect(keysText(shortcut('new-sweep').chord, true)).toBe('⇧⌘D');
    expect(keysText(shortcut('palette').chord, true)).toBe('⌘K');
    expect(keysText(shortcut('settings').chord, true)).toBe('⌘,');
    expect(keysText(shortcut('shortcuts').chord, true)).toBe('?');
    expect(keysText(shortcut('back').also!.mac, true)).toBe('⌘←');
  });

  test('elsewhere, the keys\' names joined by plus signs', () => {
    expect(keysText(shortcut('new-sweep').chord, false)).toBe('Ctrl+Shift+D');
    expect(keysText(shortcut('back').chord, false)).toBe('Ctrl+[');
    expect(keysText(shortcut('back').also!.other, false)).toBe('Alt+←');
  });

  test('aria-keyshortcuts names the modifier as the platform has it', () => {
    expect(ariaKeys(shortcut('new-sweep').chord, true)).toBe('Meta+Shift+D');
    expect(ariaKeys(shortcut('ask').chord, false)).toBe('Control+Slash');
    expect(ariaKeys(shortcut('shortcuts').chord, true)).toBe('?');
  });
});

describe('where a key is typing, and when a dialog holds the keyboard', () => {
  test('text fields, text areas, list boxes, and editable text are typing; buttons and boxes to tick are not', () => {
    const field = (type: string) => Object.assign(document.createElement('input'), { type });
    expect(isTyping(field('text'))).toBe(true);
    expect(isTyping(field('search'))).toBe(true);
    expect(isTyping(field('date'))).toBe(true);
    expect(isTyping(document.createElement('textarea'))).toBe(true);
    expect(isTyping(document.createElement('select'))).toBe(true);
    const editable = document.createElement('div');
    editable.setAttribute('contenteditable', 'true');
    const inside = document.createElement('span');
    editable.append(inside);
    expect(isTyping(inside)).toBe(true);
    expect(isTyping(field('checkbox'))).toBe(false);
    expect(isTyping(document.createElement('button'))).toBe(false);
    expect(isTyping(null)).toBe(false);
  });

  test('an open dialog blocks the shortcuts unless it is the shell\'s own', () => {
    document.body.innerHTML = '';
    expect(blockingDialogOpen(document)).toBe(false);
    const palette = document.createElement('dialog');
    palette.setAttribute('open', '');
    palette.setAttribute('data-shell-dialog', '');
    document.body.append(palette);
    expect(blockingDialogOpen(document)).toBe(false);
    const confirm = document.createElement('div');
    confirm.setAttribute('aria-modal', 'true');
    document.body.append(confirm);
    expect(blockingDialogOpen(document)).toBe(true);
    document.body.innerHTML = '';
  });
});

describe('the app menu carries the same keys and sends the commands the renderer knows', () => {
  const main = fs.readFileSync(path.resolve(__dirname, '../../../../electron/main.ts'), 'utf8');
  const menu = main.slice(main.indexOf('function installApplicationMenu'), main.indexOf('\n}\n', main.indexOf('function installApplicationMenu')));

  test.each([
    ['New Conversation', 'CmdOrCtrl+N', 'new-conversation'],
    ['New Deep Dive', 'CmdOrCtrl+D', 'new-dive'],
    ['New Deep Sweep', 'Shift+CmdOrCtrl+D', 'new-sweep'],
  ])('%s is %s, and sends %s', (label, accelerator, command) => {
    expect(menu).toContain(`label: '${label}', accelerator: '${accelerator}', click: send('${command}')`);
    expect(isMenuCommand(command)).toBe(true);
  });

  test('Settings and Keyboard Shortcuts are there too, and ⌘W is not reassigned', () => {
    expect(menu).toContain("accelerator: 'CmdOrCtrl+,', click: send('settings')");
    expect(menu).toContain("label: 'Keyboard Shortcuts', click: send('shortcuts')");
    expect(menu).not.toMatch(/CmdOrCtrl\+W|Cmd\+W/);
    expect([...MENU_COMMANDS].sort()).toEqual(['new-conversation', 'new-dive', 'new-sweep', 'settings', 'shortcuts']);
    expect(isMenuCommand('quit')).toBe(false);
  });

  test('the History menu\'s keys are the ones the sheet names for back and forward', () => {
    expect(menu).toContain("accelerator: isMac ? 'Cmd+[' : 'Alt+Left'");
    expect(menu).toContain("accelerator: isMac ? 'Cmd+Left' : 'Backspace'");
  });
});
