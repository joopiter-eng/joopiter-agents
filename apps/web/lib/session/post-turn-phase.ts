export const SESSION_POST_TURN_PHASES = ["auto_commit", "auto_pr"] as const;

export type SessionPostTurnPhase = (typeof SESSION_POST_TURN_PHASES)[number];
