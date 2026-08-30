import type { Availability } from './features';

export type ExtensionCategory = 'recommended' | 'experimental';

export interface ExtensionExample {
  id: string;
  title: string;
  file: string;
  surface: string;
  status: Availability;
  category: ExtensionCategory;
  outcome: string;
  adaptPrompt: string;
  note?: string;
}

export const extensionExamples = [
  { id: 'global-notepad', title: 'Global notepad', file: 'notepad.ts', surface: 'Panel · FAB · settings', status: 'recommended', category: 'recommended', outcome: 'Keep a machine-global planner beside every session.', adaptPrompt: 'Adapt the notepad example to track project decisions. Keep automatic model context off.' },
  { id: 'github-repository', title: 'GitHub PRs and issues', file: 'github-repo-panel.ts', surface: 'Git tab · composer context', status: 'recommended', category: 'recommended', outcome: 'Browse repository work and attach selected context.', adaptPrompt: 'Adapt the GitHub tab to show open reviews assigned to me.', note: 'Requires an authenticated gh CLI and a GitHub remote.' },
  { id: 'session-recap', title: 'Session recap', file: 'recap.ts', surface: 'Header action', status: 'recommended', category: 'recommended', outcome: 'Generate a terse handoff from the current session.', adaptPrompt: 'Turn recap into three bullets: done, open, next.' },
  { id: 'artifact-reference', title: 'Artifact reference', file: 'artifact-reference.ts', surface: 'Artifact action', status: 'recommended', category: 'recommended', outcome: 'Show artifact metadata and a ready-to-copy Markdown link.', adaptPrompt: 'Adapt this action to include an artifact reference in a project handoff.' },
  { id: 'live-git-footer', title: 'Live Git footer', file: 'git-footer.ts', surface: 'Footer · invalidation', status: 'recommended', category: 'recommended', outcome: 'Show branch and working-tree state below the composer.', adaptPrompt: 'Emphasize untracked files and hide clean-state text.' },
  { id: 'session-orchestration', title: 'Session orchestration', file: 'session-orchestrator.ts', surface: 'Tools · visible sessions', status: 'experimental', category: 'experimental', outcome: 'Spawn and monitor ordinary worker sessions.', adaptPrompt: 'Review the orchestrator and companion skill before proposing a research category.', note: 'Experimental · opt-in. Requires the companion skill and configured model categories.' },
] as const satisfies readonly ExtensionExample[];

export const recommendedExamples = extensionExamples.filter((example) => example.category === 'recommended');
export const experimentalExamples = extensionExamples.filter((example) => example.category === 'experimental');
