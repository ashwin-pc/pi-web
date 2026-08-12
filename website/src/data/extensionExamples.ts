import type { Availability } from './features';

export interface ExtensionExample {
  id: string;
  title: string;
  file: string;
  surface: string;
  maturity: string;
  status: Availability;
  outcome: string;
  prerequisites: string;
  installNote: string;
  adaptPrompt: string;
  extraProjectCommand?: string;
  extraGlobalCommand?: string;
}

export const extensionExamples = [
  {
    id: 'global-notepad',
    title: 'Global notepad',
    file: 'notepad.ts',
    surface: 'Panel · FAB · settings · tool',
    maturity: 'Audited opt-in example',
    status: 'opt-in',
    outcome: 'Keep a machine-global day planner with provenance, lifecycle, archive controls, and optional agent context.',
    prerequisites: 'No external CLI. Review its machine-global storage and context-sharing settings before use.',
    installNote: 'Project install loads the UI from one workspace; the notepad data itself is intentionally machine-global.',
    adaptPrompt: 'Adapt the notepad example to track decisions instead of tasks. Preserve provenance and keep automatic model context off by default.',
  },
  {
    id: 'github-repository',
    title: 'GitHub PRs and issues',
    file: 'github-repo-panel.ts',
    surface: 'Git tab · composer context',
    maturity: 'Audited opt-in example',
    status: 'opt-in',
    outcome: 'Browse pull requests and issues for the current GitHub repository, then attach selected context to a request.',
    prerequisites: 'A GitHub remote plus the gh CLI installed and authenticated; verify with gh auth status.',
    installNote: 'The tab appears only when the extension can identify a supported GitHub remote.',
    adaptPrompt: 'Adapt this GitHub tab to show only open review requests assigned to me. Keep the existing gh prerequisite and error states.',
  },
  {
    id: 'session-recap',
    title: 'Session recap',
    file: 'recap.ts',
    surface: 'Header action · Markdown popover',
    maturity: 'Audited opt-in example',
    status: 'opt-in',
    outcome: 'Generate a deliberately terse recap of the current session from a header action.',
    prerequisites: 'An active session with messages and a configured model/provider available through pi.',
    installNote: 'The recap invokes the current model; review provider usage before adapting the prompt or output length.',
    adaptPrompt: 'Adapt the recap action into a three-bullet handoff: completed work, open question, and recommended next step.',
  },
  {
    id: 'download-artifact',
    title: 'Download artifact',
    file: 'download-artifact.ts',
    surface: 'Artifact action · download effect',
    maturity: 'Minimal opt-in example',
    status: 'opt-in',
    outcome: 'Add an authenticated Download action to artifact preview cards.',
    prerequisites: 'No external CLI. Open a supported artifact preview to use the contribution.',
    installNote: 'This is the smallest example for learning the rendered contribution and download effect.',
    adaptPrompt: 'Adapt this action so its label says “Save handoff” and it appears only for Markdown and HTML artifacts.',
  },
  {
    id: 'live-git-footer',
    title: 'Live Git footer',
    file: 'git-footer.ts',
    surface: 'Footer · live invalidation',
    maturity: 'Audited opt-in example',
    status: 'opt-in',
    outcome: 'Show the current branch and dirty or clean state below the composer, refreshing around relevant activity.',
    prerequisites: 'A local Git repository and the git executable available to the pi-web process.',
    installNote: 'The example polls locally and refreshes around turns, shell commands, and compaction events.',
    adaptPrompt: 'Adapt this footer to emphasize untracked files and hide the clean-state text. Preserve timeouts and cleanup.',
  },
  {
    id: 'session-orchestration',
    title: 'Session orchestration',
    file: 'session-orchestrator.ts',
    surface: 'Tools · settings · visible sessions · wakeups',
    maturity: 'Experimental opt-in example',
    status: 'experimental',
    outcome: 'Let one session spawn, monitor, read, steer, prompt, and abort ordinary visible worker sessions with durable completion wakeups.',
    prerequisites: 'Install the companion skill and configure user-authored model categories in Extension settings.',
    installNote: 'This is not core and is not enabled by default. Workers are normal sessions; review tool access and model costs.',
    adaptPrompt: 'Review the experimental orchestrator and companion skill. Propose a category for research work without changing fail-closed model resolution.',
    extraProjectCommand: 'mkdir -p ~/.pi/agent/skills && cp -R examples/pi-web-skills/session-orchestration ~/.pi/agent/skills/session-orchestration',
    extraGlobalCommand: 'mkdir -p ~/.pi/agent/skills && cp -R examples/pi-web-skills/session-orchestration ~/.pi/agent/skills/session-orchestration',
  },
] as const satisfies readonly ExtensionExample[];
