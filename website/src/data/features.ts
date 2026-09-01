export type Availability = 'available' | 'recommended' | 'opt-in' | 'experimental' | 'foundation' | 'direction';

export interface FeatureRoute {
  slug: 'work-from-anywhere' | 'keep-the-thread' | 'rich-results' | 'stay-in-control';
  eyebrow: string;
  shortTitle: string;
  title: string;
  lede: string;
  capabilities: readonly string[];
}

export const featureRoutes = [
  {
    slug: 'work-from-anywhere',
    eyebrow: 'Work from anywhere',
    shortTitle: 'Responsive workspace',
    title: 'Your agent workspace, on the screen you have.',
    lede: 'The same sessions and results, shaped for desktop or phone. You operate the server and choose the network path.',
    capabilities: ['Responsive workspace', 'Installable PWA', 'Draft recovery', 'Completion alerts', 'Token QR handoff'],
  },
  {
    slug: 'keep-the-thread',
    eyebrow: 'Keep the thread',
    shortTitle: 'Sessions and branches',
    title: 'Do more without losing the thread.',
    lede: 'Keep parallel work organized, preserve branches, and return to the right context.',
    capabilities: ['Persistent sessions', 'Quote replies', 'Steer · follow-up queues', 'Pinned · Parked · Bookmarks', 'Branches'],
  },
  {
    slug: 'rich-results',
    eyebrow: 'Rich results',
    shortTitle: 'Messages and artifacts',
    title: 'Results you can see, inspect, and use.',
    lede: 'Browse the handoff, preview the result, and keep the work beside the conversation.',
    capabilities: ['Rich transcripts', 'Image + file attachments', 'Mermaid viewer', 'Interactive HTML', 'Artifact gallery'],
  },
  {
    slug: 'stay-in-control',
    eyebrow: 'Stay in control',
    shortTitle: 'Tools, models, and files',
    title: 'Stay close enough to trust the work.',
    lede: 'Inspect files and repository changes without leaving the session that produced them.',
    capabilities: ['Models + reasoning', 'Context + recovery', 'Slash + shell commands', 'Safe workspace saves', 'Git sync + diffs'],
  },
] as const satisfies readonly FeatureRoute[];

export interface CapabilityGroup {
  id: string;
  title: string;
  description: string;
  items: readonly string[];
  route: FeatureRoute['slug'];
  anchor: string;
}

/** Canonical directory for the default product, reused by feature discovery surfaces. */
export const capabilityGroups = [
  {
    id: 'agent-activity',
    title: 'Agent activity',
    description: 'Follow the work as it happens, not only the final answer.',
    items: ['Tool names and descriptions', 'Arguments, progress, and results', 'Expandable partial tool output', 'Thinking, errors, and retry'],
    route: 'stay-in-control',
    anchor: 'run-controls',
  },
  {
    id: 'messages',
    title: 'Messages and output',
    description: 'Read, inspect, and reuse rich responses.',
    items: ['Markdown and code', 'Copy controls', 'Mermaid diagrams', 'Images, HTML, and artifacts'],
    route: 'rich-results',
    anchor: 'rich-transcript',
  },
  {
    id: 'conversation-control',
    title: 'Conversation control',
    description: 'Change direction without losing what came before.',
    items: ['Stop and retry', 'Steer and follow-up', 'Edit and continue', 'Quote replies and branching'],
    route: 'keep-the-thread',
    anchor: 'reply-redirect-continue',
  },
  {
    id: 'inputs',
    title: 'Inputs and attachments',
    description: 'Bring the material for the task into the thread.',
    items: ['File picker and drag-and-drop', 'Image attachments', 'Attachment-only prompts', 'Restored attachment drafts'],
    route: 'rich-results',
    anchor: 'attachments',
  },
  {
    id: 'models-context',
    title: 'Models and context',
    description: 'Choose how the session runs and see its limits.',
    items: ['Model and reasoning selection', 'Context usage', 'Compaction controls', 'Failure continuation'],
    route: 'stay-in-control',
    anchor: 'run-controls',
  },
  {
    id: 'session-memory',
    title: 'Sessions and continuity',
    description: 'Leave, return, and keep the work understandable.',
    items: ['Persistent sessions', 'Draft recovery', 'Pinned and parked lanes', 'Bookmarks and branches'],
    route: 'keep-the-thread',
    anchor: 'sessions-and-branches',
  },
] as const satisfies readonly CapabilityGroup[];

export const getFeatureRoute = (slug: FeatureRoute['slug']) => {
  const feature = featureRoutes.find((item) => item.slug === slug);
  if (!feature) throw new Error(`Unknown feature route: ${slug}`);
  return feature;
};
