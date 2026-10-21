// Single keymap: key name -> action. Stage 3 adds the rest of the shortcuts here.
type Action = () => void | Promise<void>;

export type Keymap = Record<string, Action>;

/** "Ctrl+o", "j", "G", "ArrowDown", ... Letters with Ctrl are lowercased so Shift doesn't change the name. */
function keyName(e: KeyboardEvent): string {
  const ctrl = e.ctrlKey || e.metaKey;
  const key = ctrl && e.key.length === 1 ? e.key.toLowerCase() : e.key;
  return (ctrl ? "Ctrl+" : "") + key;
}

function isTyping(target: EventTarget | null): boolean {
  return (
    target instanceof HTMLInputElement ||
    target instanceof HTMLTextAreaElement ||
    (target instanceof HTMLElement && target.isContentEditable)
  );
}

export function bindKeys(keymap: Keymap) {
  window.addEventListener("keydown", (e) => {
    if (isTyping(e.target)) return;
    const action = keymap[keyName(e)];
    if (!action) return;
    e.preventDefault();
    void action();
  });
}
