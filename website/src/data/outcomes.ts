export type OutcomeStatus = 'available' | 'direction';

export interface ProductOutcome {
  id: 'anywhere' | 'thread' | 'results' | 'control' | 'adapt';
  eyebrow: string;
  title: string;
  description: string;
  proof: readonly string[];
  href: string;
  status: OutcomeStatus;
}

export const outcomes = [
  {
    id: 'anywhere',
    eyebrow: 'Work from anywhere',
    title: 'Carry the workspace with you.',
    description:
      'Move between desktop, tablet, and phone while keeping the active session, drafts, and results within reach.',
    proof: ['Responsive workspace', 'Installable PWA', 'Completion alerts'],
    href: 'features/work-from-anywhere/',
    status: 'available',
  },
  {
    id: 'thread',
    eyebrow: 'Keep the thread',
    title: 'Parallel work stays understandable.',
    description:
      'Organize meaningful efforts into persistent sessions, quick tabs, and lanes—then steer, queue, branch, or resume.',
    proof: ['Persistent sessions', 'Pinned · Parked · Bookmarks', 'Branches and queues'],
    href: 'features/keep-the-thread/',
    status: 'available',
  },
  {
    id: 'results',
    eyebrow: 'Rich results',
    title: 'Turn responses into deliverables.',
    description:
      'Inspect tools and rich transcripts, then open images, Markdown, HTML, diagrams, video, PDFs, and files as real outputs.',
    proof: ['Inspectable tools', 'Artifact gallery', 'Interactive previews'],
    href: 'features/rich-results/',
    status: 'available',
  },
  {
    id: 'control',
    eyebrow: 'Stay in control',
    title: 'See the work, not just the answer.',
    description:
      'Redirect a run, inspect workspace files and changes, choose models, and understand Git state without losing context.',
    proof: ['Run controls', 'Files and diffs', 'Git inspection and sync'],
    href: 'features/stay-in-control/',
    status: 'available',
  },
  {
    id: 'adapt',
    eyebrow: 'Make it yours',
    title: 'Shape the interface around the work.',
    description:
      'Ask your agent to build a project-specific panel, action, setting, or workflow UI with pi-web extensions.',
    proof: ['Typed contribution API', 'Project or global scope', 'Shipped examples'],
    href: 'extensions/',
    status: 'available',
  },
] as const satisfies readonly ProductOutcome[];
