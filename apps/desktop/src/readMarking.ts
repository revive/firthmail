/**
 * Read-marking rules, kept free of React and Tauri so `node --test` can pin
 * them (see `tests/readMarking.test.ts`).
 *
 * Two rules were wrong once and are the reason this module exists:
 * the reading pane's toggle passed "set it unread" while the button asked to
 * mark the message read, so every click asked for the state the message
 * already had - and the engine silently skips such a no-op, leaving the UI
 * looking dead. Since then the wanted state is a plain boolean everywhere,
 * and the engine action is derived in one place.
 */

/** The engine action kind (`ActionKind`) that applies a wanted read state. */
export function readActionKind(read: boolean): 'mark_read' | 'mark_unread' {
  return read ? 'mark_read' : 'mark_unread';
}

/** The read state a toggle applies to the message on screen. */
export function toggledReadState(isRead: boolean): boolean {
  return !isRead;
}

/**
 * Whether an opened message starts the auto-read wait. Only unread mail
 * waits: read mail has nothing to mark.
 */
export function startsAutoReadWait(isRead: boolean): boolean {
  return !isRead;
}

/** What the reading pane remembers about the auto-read wait in progress. */
export interface AutoReadWait {
  /** The message the wait belongs to. */
  id: number | null;
  /** The user toggled the read state by hand: never auto-mark this one. */
  suppressed: boolean;
}

/**
 * Whether the auto-read wait may mark its message now: it must belong to the
 * message on screen, that message must still be selected (the user may have
 * moved on), and the user must not have toggled it by hand.
 */
export function autoReadDue(
  wait: AutoReadWait,
  openedId: number,
  selectedId: number | null,
): boolean {
  return wait.id === openedId && !wait.suppressed && selectedId === openedId;
}
