/**
 * Sends an alert to Slack when a job fails permanently (after max retries).
 */
export async function sendAlert(message: string, details?: Record<string, unknown>): Promise<void> {
  const webhookUrl = process.env.SLACK_ALERT_WEBHOOK_URL;
  if (!webhookUrl) {
    console.error('[alerting] SLACK_ALERT_WEBHOOK_URL not set — alert suppressed:', message);
    return;
  }

  const text = details
    ? `${message}\n\`\`\`${JSON.stringify(details, null, 2)}\`\`\``
    : message;

  try {
    const res = await fetch(webhookUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text }),
    });
    if (!res.ok) {
      console.error('[alerting] Slack webhook failed:', res.status, await res.text());
    }
  } catch (err) {
    console.error('[alerting] Failed to send Slack alert:', err);
  }
}
