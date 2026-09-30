import type { GitCommitDetailsResponse, GitDiffResponse, GitLogResponse, GitReposResponse, GitStatusResponse, GitSyncResponse } from "./types.js";

async function getJson<T>(url: string, headers: HeadersInit): Promise<T> {
  const res = await fetch(url, { headers });
  if (!res.ok) throw new Error(await res.text());
  return res.json() as Promise<T>;
}

async function postJson<T>(url: string, headers: HeadersInit): Promise<T> {
  const res = await fetch(url, { method: "POST", headers });
  if (!res.ok) throw new Error(await res.text());
  return res.json() as Promise<T>;
}

export type GitResourceScope = string | { workspaceId: string };

function queryWithRepo(values: Record<string, string> = {}, repo?: string, sessionId?: GitResourceScope) {
  const query = new URLSearchParams(values);
  if (repo) query.set("repo", repo);
  if (typeof sessionId === "string" && sessionId) query.set("sessionId", sessionId);
  else if (sessionId && typeof sessionId === "object") query.set("workspaceId", sessionId.workspaceId);
  return query;
}

export function fetchGitRepos(headers: HeadersInit, sessionId?: GitResourceScope) {
  const query = queryWithRepo({}, undefined, sessionId);
  return getJson<GitReposResponse>(`/api/git/repos?${query}`, headers);
}

export function fetchGitStatus(headers: HeadersInit, repo?: string, fetchRemote = false, sessionId?: GitResourceScope) {
  const query = queryWithRepo(fetchRemote ? { fetch: "1" } : {}, repo, sessionId);
  return getJson<GitStatusResponse>(`/api/git/status?${query}`, headers);
}

export function fetchGitLog(headers: HeadersInit, repo?: string, sessionId?: GitResourceScope) {
  const query = queryWithRepo({}, repo, sessionId);
  return getJson<GitLogResponse>(`/api/git/log?${query}`, headers);
}

export function fetchGitDiff(headers: HeadersInit, path: string, staged: boolean, repo?: string, sessionId?: GitResourceScope) {
  const query = queryWithRepo({ path, staged: staged ? "1" : "0" }, repo, sessionId);
  return getJson<GitDiffResponse>(`/api/git/diff?${query}`, headers);
}

export function fetchGitCommit(headers: HeadersInit, hash: string, repo?: string, sessionId?: GitResourceScope) {
  const query = queryWithRepo({ hash }, repo, sessionId);
  return getJson<GitCommitDetailsResponse>(`/api/git/commit?${query}`, headers);
}

export function syncGit(headers: HeadersInit, repo?: string, sessionId?: GitResourceScope) {
  const query = queryWithRepo({}, repo, sessionId);
  return postJson<GitSyncResponse>(`/api/git/sync?${query}`, headers);
}
