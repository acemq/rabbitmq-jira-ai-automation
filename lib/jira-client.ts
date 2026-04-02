import { markdownToAdf } from './markdown-to-adf.js';

if (!process.env.JIRA_BASE_URL) throw new Error('JIRA_BASE_URL is required');
if (!process.env.JIRA_USER_EMAIL) throw new Error('JIRA_USER_EMAIL is required');
if (!process.env.JIRA_API_TOKEN) throw new Error('JIRA_API_TOKEN is required');

const BASE_URL = process.env.JIRA_BASE_URL.replace(/\/$/, '');
const AUTH = Buffer.from(
  `${process.env.JIRA_USER_EMAIL}:${process.env.JIRA_API_TOKEN}`
).toString('base64');

async function jiraFetch<T>(
  path: string,
  options: RequestInit = {}
): Promise<T> {
  const url = `${BASE_URL}/rest/api/3${path}`;
  const res = await fetch(url, {
    ...options,
    headers: {
      Authorization: `Basic ${AUTH}`,
      'Content-Type': 'application/json',
      Accept: 'application/json',
      ...(options.headers ?? {}),
    },
  });

  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Jira API error ${res.status} at ${path}: ${body}`);
  }

  return res.json() as Promise<T>;
}

/**
 * Fetches a single issue by key. Expands names to help find custom field IDs.
 */
export async function getIssue(issueKey: string): Promise<Record<string, unknown>> {
  return jiraFetch(`/issue/${issueKey}?expand=names`);
}

/**
 * Posts a customer-visible comment on a Jira Service Management issue.
 * The comment is posted in ADF format with sd.public.comment set to internal: false.
 */
export async function postComment(
  issueKey: string,
  markdownBody: string
): Promise<{ id: string }> {
  const adf = markdownToAdf(markdownBody);

  const payload = {
    body: adf,
    // Makes the comment visible on the JSM customer portal
    properties: [
      {
        key: 'sd.public.comment',
        value: { internal: false },
      },
    ],
  };

  const result = await jiraFetch<{ id: string }>(
    `/issue/${issueKey}/comment`,
    {
      method: 'POST',
      body: JSON.stringify(payload),
    }
  );

  return { id: result.id };
}

/**
 * Returns all comments on an issue. Used for collision detection.
 */
export async function getComments(issueKey: string): Promise<Array<{
  id: string;
  author: { emailAddress: string; displayName: string };
  body: unknown;
}>> {
  const result = await jiraFetch<{
    comments: Array<{
      id: string;
      author: { emailAddress: string; displayName: string };
      body: unknown;
    }>;
  }>(`/issue/${issueKey}/comment`);
  return result.comments ?? [];
}

/**
 * Adds a label to an issue. Does not overwrite existing labels.
 */
export async function addLabel(issueKey: string, label: string): Promise<void> {
  const issue = await jiraFetch<{ fields: { labels: string[] } }>(
    `/issue/${issueKey}?fields=labels`
  );
  const existing = issue.fields.labels ?? [];
  if (existing.includes(label)) return;

  await jiraFetch(`/issue/${issueKey}`, {
    method: 'PUT',
    body: JSON.stringify({
      fields: { labels: [...existing, label] },
    }),
  });
}

/**
 * Fetches resolved tickets for a project from the last N days.
 */
export async function getResolvedTickets(
  projectKey: string,
  daysBack = 365,
  nextPageToken?: string,
  maxResults = 50
): Promise<{
  issues: Array<Record<string, unknown>>;
  nextPageToken?: string;
  isLast: boolean;
}> {
  const jql = `project = ${projectKey} AND statusCategory = Done AND updated >= -${daysBack}d ORDER BY updated DESC`;
  const body: Record<string, unknown> = {
    jql,
    maxResults,
    fields: ['summary', 'description', 'comment', 'resolution', 'assignee', 'reporter', 'created', 'resolved', 'labels', process.env.JIRA_ORG_FIELD_ID ?? 'customfield_10002'],
  };
  if (nextPageToken) body.nextPageToken = nextPageToken;

  const result = await jiraFetch<{
    issues: Array<Record<string, unknown>>;
    nextPageToken?: string;
    isLast?: boolean;
  }>(`/search/jql`, { method: 'POST', body: JSON.stringify(body) });

  return {
    issues: result.issues ?? [],
    nextPageToken: result.nextPageToken,
    isLast: result.isLast ?? !result.nextPageToken,
  };
}

/**
 * Returns the configured organization custom field ID.
 */
export function getOrgFieldId(): string {
  return process.env.JIRA_ORG_FIELD_ID ?? 'customfield_10002';
}
