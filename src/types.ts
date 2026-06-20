export const ROLES = ['orchestrator', 'backend', 'frontend', 'reviewer'] as const;
export type Role = (typeof ROLES)[number];
export type Harness = 'claude' | 'codex';
export type AuthMode = 'subscription' | 'official-api' | 'proxy';

export interface HarnessProfile {
  role: Role;
  harness: Harness;
  authMode: AuthMode;
  model: string;
  baseUrl?: string;
  apiKeyEnv?: string;
  readOnly?: boolean;
  writableGlobs?: string[];
}

export interface AppConfig {
  guildId: string;
  forumChannelId: string;
  runtimeRoot: string;
  harnessRoot: string;
  projectsRoot: string;
  databasePath: string;
  tokens: Record<Role, string>;
  profiles: Record<Role, HarnessProfile>;
}

export type CommandEventType =
  | 'task.complete'
  | 'task.blocked'
  | 'review.verdict'
  | 'review.rework'
  | 'dispute.raise'
  | 'dispute.resolve'
  | 'merge.request';

export interface CommandEvent {
  version: 1;
  id: string;
  type: CommandEventType;
  goalId: string;
  taskId?: string;
  actor: Role;
  timestamp: string;
  payload: Record<string, unknown>;
}
