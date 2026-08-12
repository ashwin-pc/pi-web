import type { Availability } from './features';

export interface ExtensionExample {
  id: string;
  title: string;
  file: string;
  surface: string;
  status: Availability;
  outcome: string;
  adaptPrompt: string;
  note?: string;
}

export const extensionExamples = [
  { id: 'global-notepad', title: 'Global notepad', file: 'notepad.ts', surface: 'Panel · FAB · settings', status: 'opt-in', outcome: 'Keep a machine-global planner beside every session.', adaptPrompt: 'Adapt the notepad example to track project decisions. Keep automatic model context off.' },
  { id: 'github-repository', title: 'GitHub PRs and issues', file: 'github-repo-panel.ts', surface: 'Git tab · composer context', status: 'opt-in', outcome: 'Browse repository work and attach selected context.', adaptPrompt: 'Adapt the GitHub tab to show open reviews assigned to me.', note: 'Requires an authenticated gh CLI and a GitHub remote.' },
  { id: 'session-recap', title: 'Session recap', file: 'recap.ts', surface: 'Header action', status: 'opt-in', outcome: 'Generate a terse handoff from the current session.', adaptPrompt: 'Turn recap into three bullets: done, open, next.' },
  { id: 'download-artifact', title: 'Download artifact', file: 'download-artifact.ts', surface: 'Artifact action', status: 'opt-in', outcome: 'Add an authenticated Download action to previews.', adaptPrompt: 'Rename this action “Save handoff” and limit it to Markdown and HTML.' },
  { id: 'live-git-footer', title: 'Live Git footer', file: 'git-footer.ts', surface: 'Footer · invalidation', status: 'opt-in', outcome: 'Show branch and working-tree state below the composer.', adaptPrompt: 'Emphasize untracked files and hide clean-state text.' },
  { id: 'session-orchestration', title: 'Session orchestration', file: 'session-orchestrator.ts', surface: 'Tools · visible sessions', status: 'experimental', outcome: 'Spawn and monitor ordinary worker sessions.', adaptPrompt: 'Review the orchestrator and companion skill before proposing a research category.', note: 'Experimental · opt-in. Requires the companion skill and configured model categories.' },
] as const satisfies readonly ExtensionExample[];
