export type Availability = 'available' | 'opt-in' | 'experimental' | 'foundation' | 'direction';

export interface Capability {
  title: string;
  description: string;
  status?: Availability;
}

export interface FeatureRoute {
  slug: string;
  eyebrow: string;
  title: string;
  lede: string;
  summary: string;
  capabilities: readonly Capability[];
}

export const featureRoutes = [
  {
    slug: 'work-from-anywhere',
    eyebrow: 'Work from anywhere',
    title: 'Your agent workspace, on the screen you have.',
    lede: 'Check progress, steer a run, and return to the same work from a responsive browser workspace you operate.',
    summary: 'Responsive continuity without a hosted service.',
    capabilities: [
      { title: 'One responsive workspace', description: 'Desktop side panels become focused tablet and phone views without splitting your sessions across separate clients.' },
      { title: 'Installable PWA', description: 'Open pi-web as a standalone app and receive service-worker updates without installing a separate native client.' },
      { title: 'Return where you left off', description: 'Session URLs, browser history, saved drafts, attachments, quote replies, and reconnection restore the work around interruptions.' },
      { title: 'Completion alerts', description: 'Optional Web Push, sound, and supported-device vibration can tell you when background work finishes. Browser and HTTPS support are required.' },
      { title: 'Trusted-device handoff', description: 'Protect API and WebSocket access with an optional bearer token, then explicitly generate a device link or QR from Settings.' },
      { title: 'Your network boundary', description: 'Reach the localhost-bound app through Tailscale or another secure proxy you control. pi-web provides no hosted relay or identity service.' },
    ],
  },
  {
    slug: 'keep-the-thread',
    eyebrow: 'Keep the thread',
    title: 'Do more without losing the thread.',
    lede: 'Persistent sessions make parallel work understandable while queues, branches, and precise replies keep every continuation grounded.',
    summary: 'Sessions are durable workspaces, not disposable chats.',
    capabilities: [
      { title: 'Persistent sessions', description: 'Search, group, name, resume, pin, or remove sessions while running and unread state stays visible.' },
      { title: 'Quick tabs and lanes', description: 'Keep active sessions one tap away, then sort the wider set into Pinned, Parked, and Bookmarks with notes, colors, and ordering.' },
      { title: 'Steer now, queue next', description: 'Redirect a running agent, line up a follow-up, inspect pending messages, or stop the run. These controls are available with pi.' },
      { title: 'Branch without erasing', description: 'Search a compact conversation graph, return to an earlier point, edit and rerun a request, or continue from a response.' },
      { title: 'Reply to exact passages', description: 'Link separate questions to selected text in an agent response so detailed feedback survives reload and submission.' },
      { title: 'Visible worker sessions', description: 'An optional example lets one session delegate to ordinary visible sessions. It is not a built-in orchestration feature.', status: 'experimental' },
    ],
  },
  {
    slug: 'rich-results',
    eyebrow: 'Rich results',
    title: 'Results you can see, inspect, and use.',
    lede: 'Agent output becomes a readable transcript, visible work, and a gallery of deliverables—not a pile of raw event logs.',
    summary: 'Move from progress to a usable handoff in one workspace.',
    capabilities: [
      { title: 'Readable transcripts', description: 'Sanitized Markdown, highlighted code, thinking cards, errors, and long-response disclosure keep dense work legible.' },
      { title: 'Inspectable tool activity', description: 'Follow running tools, partial output, arguments, elapsed and quiet state, images, results, and failures in expandable cards.' },
      { title: 'Visual explanations', description: 'Render Mermaid diagrams inline and open them with zoom, source, and reset controls.' },
      { title: 'Interactive previews', description: 'Use agent-produced HTML figures inside a sandbox with sizing and source controls.' },
      { title: 'Artifacts as deliverables', description: 'Browse images, HTML, Markdown, video, PDFs, generic files, and folders; preview supported formats or open and download them.' },
      { title: 'Bring source material', description: 'Drop or pick images and generic files, send attachment-only requests, restore drafts, and inspect visual output full-screen.' },
    ],
  },
  {
    slug: 'stay-in-control',
    eyebrow: 'Stay in control',
    title: 'Stay close enough to trust the work.',
    lede: 'See what the agent is doing, intervene while it runs, and verify the result through files, tools, diffs, and operational context.',
    summary: 'Control is visible, specific, and close to the work.',
    capabilities: [
      { title: 'Intervene during a run', description: 'Stop, steer, queue a follow-up, pause stream-follow, jump to latest, or inspect exactly what will happen next.' },
      { title: 'Choose the working mode', description: 'Select models and reasoning exposed by pi, monitor context, compact it, and retry or switch models after a failure.' },
      { title: 'Inspect tools and commands', description: 'Expand live tool activity, discover slash commands, and run shell commands either in or outside agent context.' },
      { title: 'Explore files safely', description: 'Open and edit workspace files with revision-conflict detection, atomic writes, and server checks against traversal, unsafe links, binary, or oversized edits.' },
      { title: 'Review exact changes', description: 'Use the shared stacked or side-by-side diff viewer for edit-tool and Git changes, including intraline highlighting.' },
      { title: 'Understand Git state', description: 'Inspect status, branches, graph, history, file and commit diffs; fetch and rebase-pull with explicit progress. pi-web does not claim to commit or push.' },
    ],
  },
] as const satisfies readonly FeatureRoute[];

export const getFeatureRoute = (slug: FeatureRoute['slug']) => {
  const feature = featureRoutes.find((item) => item.slug === slug);
  if (!feature) throw new Error(`Unknown feature route: ${slug}`);
  return feature;
};
