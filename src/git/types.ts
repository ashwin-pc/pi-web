export type GitExtensionPrimaryView = `extension:${string}`;
export type GitPrimaryView = "status" | "graph" | GitExtensionPrimaryView;
export type GitView = GitPrimaryView | "diff" | "commit";

export type GitFileLabel = "modified" | "added" | "deleted" | "renamed" | "untracked" | "staged" | "conflicted";

export type GitFileStatus = {
  path: string;
  oldPath?: string;
  indexStatus: string;
  worktreeStatus: string;
  label: GitFileLabel;
  staged: boolean;
};

export type GitCommit = {
  hash: string;
  shortHash: string;
  parents: string[];
  author: string;
  date: string;
  refs: string[];
  subject: string;
};

export type GitRepo = {
  path: string;
  root: string;
  branch: string;
  upstream: string;
  ahead: number;
  behind: number;
  dirtyCount: number;
  isCurrent: boolean;
};

export type GitReposResponse = { ok: true; cwd: string; depth: number; repos: GitRepo[] };

export type GitStatusResponse = {
  ok: true;
  isRepo: boolean;
  root?: string;
  branch?: string;
  upstream?: string;
  defaultRemoteBranch?: string;
  ahead: number;
  behind: number;
  files: GitFileStatus[];
};

export type GitLogResponse = { ok: true; isRepo: boolean; commits: GitCommit[] };
export type GitDiffResponse = { ok: true; path: string; staged: boolean; diff: string };
export type GitCommitFile = { path: string; status: string; additions?: number; deletions?: number };
export type GitCommitDetailsResponse = { ok: true; commit: GitCommit; files: GitCommitFile[]; diff: string };
export type GitSyncResponse = { ok: true; output: string; status: GitStatusResponse };

export type GitState = {
  isOpen: boolean;
  loading: boolean;
  syncing: boolean;
  syncingRepo?: string;
  error?: string;
  status?: GitStatusResponse;
  statusesByRepo: Record<string, GitStatusResponse | undefined>;
  commits: GitCommit[];
  repos: GitRepo[];
  repoCwd?: string;
  selectedRepo?: GitRepo;
  repoPickerOpen: boolean;
  primaryView: GitPrimaryView;
  mobileView: GitView;
  selectedFile?: GitFileStatus;
  selectedFileRepo?: string;
  selectedCommit?: GitCommit;
  commitFiles?: GitCommitFile[];
  commitDiff?: string;
  commitLoading: boolean;
  diff?: string;
  diffLoading: boolean;
};
