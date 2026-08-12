export interface ProductOutcome {
  id: 'anywhere' | 'thread' | 'results' | 'control' | 'adapt';
  eyebrow: string;
  title: string;
  href: string;
  screenshot?: {
    desktop: string;
    mobile: string;
    width: number;
    height: number;
    mobileWidth?: number;
    mobileHeight?: number;
    alt: string;
    caption: string;
  };
}

export const outcomes: readonly ProductOutcome[] = [
  {
    id: 'results',
    eyebrow: 'Rich results',
    title: 'Turn responses into deliverables.',
    href: 'features/rich-results/',
    screenshot: { desktop: 'artifacts-explorer-desktop.png', mobile: 'artifacts-explorer-mobile.png', width: 1600, height: 1000, alt: 'Artifacts gallery with folders and image, HTML, Markdown, and video results', caption: 'Artifacts gallery' },
  },
  {
    id: 'thread',
    eyebrow: 'Keep the thread',
    title: 'Parallel work stays understandable.',
    href: 'features/keep-the-thread/',
    screenshot: { desktop: 'session-lanes-desktop.png', mobile: 'session-lanes-mobile.png', width: 1600, height: 1000, alt: 'Session lanes for pinned, parked, and bookmarked work', caption: 'Pinned, Parked, and Bookmarks' },
  },
  {
    id: 'control',
    eyebrow: 'Stay in control',
    title: 'See the work, not just the answer.',
    href: 'features/stay-in-control/',
    screenshot: { desktop: 'workspace-explorer-desktop.png', mobile: 'workspace-explorer-mobile.png', width: 1600, height: 1000, alt: 'Workspace Explorer with conversation, file tree, and editor', caption: 'Workspace Explorer' },
  },
  {
    id: 'anywhere',
    eyebrow: 'Work from anywhere',
    title: 'Carry the workspace with you.',
    href: 'features/work-from-anywhere/',
    screenshot: { desktop: 'new-session-desktop.png', mobile: 'new-session-mobile.png', width: 1280, height: 800, alt: 'New pi-web session on desktop and responsive mobile layouts', caption: 'Responsive new session' },
  },
  {
    id: 'adapt',
    eyebrow: 'Make it yours',
    title: 'Ask your agent to shape the interface.',
    href: 'extensions/',
    screenshot: { desktop: 'website-extension-desktop.png', mobile: 'website-extension-mobile.png', width: 1440, height: 1000, mobileWidth: 390, mobileHeight: 844, alt: 'A launch decisions extension open in the real pi-web side panel', caption: 'A real extension-contributed workflow panel' },
  },
] as const;
