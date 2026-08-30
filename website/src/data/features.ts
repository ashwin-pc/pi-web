export type Availability = 'available' | 'opt-in' | 'experimental' | 'foundation' | 'direction';

export interface FeatureRoute {
  slug: 'work-from-anywhere' | 'keep-the-thread' | 'rich-results' | 'stay-in-control';
  eyebrow: string;
  title: string;
  lede: string;
  capabilities: readonly string[];
}

export const featureRoutes = [
  {
    slug: 'work-from-anywhere',
    eyebrow: 'Work from anywhere',
    title: 'Your agent workspace, on the screen you have.',
    lede: 'The same sessions and results, shaped for desktop or phone. You operate the server and choose the network path.',
    capabilities: ['Responsive workspace', 'Installable PWA', 'Draft recovery', 'Completion alerts', 'Token QR handoff'],
  },
  {
    slug: 'keep-the-thread',
    eyebrow: 'Keep the thread',
    title: 'Do more without losing the thread.',
    lede: 'Keep parallel work organized, preserve branches, and return to the right context.',
    capabilities: ['Persistent sessions', 'Quote replies', 'Steer · follow-up queues', 'Pinned · Parked · Bookmarks', 'Branches'], 
  },
  {
    slug: 'rich-results',
    eyebrow: 'Rich results',
    title: 'Results you can see, inspect, and use.',
    lede: 'Browse the handoff, preview the result, and keep the work beside the conversation.',
    capabilities: ['Rich transcripts', 'Image + file attachments', 'Mermaid viewer', 'Interactive HTML', 'Artifact gallery'], 
  },
  {
    slug: 'stay-in-control',
    eyebrow: 'Stay in control',
    title: 'Stay close enough to trust the work.',
    lede: 'Inspect files and repository changes without leaving the session that produced them.',
    capabilities: ['Models + reasoning', 'Context + recovery', 'Slash + shell commands', 'Safe workspace saves', 'Git sync + diffs'], 
  },
] as const satisfies readonly FeatureRoute[];

export const getFeatureRoute = (slug: FeatureRoute['slug']) => {
  const feature = featureRoutes.find((item) => item.slug === slug);
  if (!feature) throw new Error(`Unknown feature route: ${slug}`);
  return feature;
};
