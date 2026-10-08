/** How a show event wants to be shown, as the Mac app's Display mirrors it. */
export const DISPLAY = {
  /** Bring the session's own window forward. */
  OPEN: 'open',
  /** Put a summary card on screen while the voice reads it. */
  CARD: 'card',
  /** Type the person's confirmed instruction into the terminal tab the agent waits in. */
  TYPE: 'type',
  /** Open the session in its editor with the instruction in its input, for the person to send. */
  PREFILL: 'prefill',
  /** Turn through the sessions to this one and bring its own terminal tab or editor forward. */
  FOCUS: 'focus',
  /** Open a new terminal tab in a repository and type the line that starts an agent there. */
  LAUNCH: 'launch',
  /** Open an agent's own desktop app on a repository, with the task handed to it through its links. */
  APP: 'app',
  /** A card that pages through a session's changed files while the voice walks through them. */
  WALK: 'walk',
  /** The whole screen: every agent on this Mac, found by a live scan, with what each reaches. */
  AGENTS: 'agents',
  /** A trace as a waterfall card: what ran, inside what, for how long, and what failed. */
  TRACE: 'trace',
  /** Every session lately as one card each, together, so they can be read at a glance. */
  SESSIONS: 'sessions',
  /** Close the live window on a session and its own terminal tab, which ends the agent there. */
  CLOSE: 'close',
  /** Take every Memnox card and window off the screen, leaving every agent and its tab alone. */
  DISMISS: 'dismiss',
  /** A message from the person's connected mail, drafted for them to read; Send is a signed CONFIRM of `subject`. */
  DRAFT: 'draft',
  /** Open a folder the person named; its title says where: finder, editor or terminal. */
  FOLDER: 'folder',
  /** Look at the screen: the Mac captures the window in front, or the app named in the title, and answers with SEEN. */
  LOOK: 'look',
} as const;

export type DisplayKind = (typeof DISPLAY)[keyof typeof DISPLAY];
