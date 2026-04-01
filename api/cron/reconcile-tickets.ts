import type { VercelRequest, VercelResponse } from '@vercel/node';
import { supabase } from '../../lib/supabase.js';
import { sendAlert } from '../../lib/alerting.js';

/**
 * Daily reconciliation cron.
 * Catches any tickets stuck in 'processing' state (crashed workers)
 * and resets them to 'pending' for retry.
 */
export default async function handler(req: VercelRequest, res: VercelResponse) {
  const authHeader = req.headers.authorization;
  if (
    process.env.CRON_SECRET &&
    authHeader !== `Bearer ${process.env.CRON_SECRET}`
  ) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  // Jobs stuck in 'processing' for more than 10 minutes are likely crashed
  const stuckCutoff = new Date();
  stuckCutoff.setMinutes(stuckCutoff.getMinutes() - 10);

  const { data: stuckJobs } = await supabase
    .from('ticket_jobs')
    .select('id, jira_issue_key, retry_count, processed_at')
    .eq('status', 'processing')
    .lt('processed_at', stuckCutoff.toISOString());

  if (stuckJobs && stuckJobs.length > 0) {
    console.log(`[reconcile] Found ${stuckJobs.length} stuck jobs — resetting to pending`);

    for (const job of stuckJobs) {
      const retryCount = (job.retry_count as number) + 1;
      await supabase
        .from('ticket_jobs')
        .update({
          status: 'pending',
          retry_count: retryCount,
          error_message: 'Reset by reconciler: stuck in processing state',
        })
        .eq('id', job.id);
    }

    await sendAlert(`Reconciler reset ${stuckJobs.length} stuck job(s) to pending`, {
      jobs: stuckJobs.map((j) => ({ id: j.id, issueKey: j.jira_issue_key })),
    });
  }

  // Report failed jobs from the last 24 hours
  const yesterday = new Date();
  yesterday.setHours(yesterday.getHours() - 24);

  const { data: failedJobs } = await supabase
    .from('ticket_jobs')
    .select('id, jira_issue_key, error_message, retry_count')
    .eq('status', 'failed')
    .gte('created_at', yesterday.toISOString());

  const summary = {
    stuck_reset: stuckJobs?.length ?? 0,
    failed_last_24h: failedJobs?.length ?? 0,
  };

  console.log('[reconcile] Summary:', summary);
  return res.status(200).json(summary);
}
