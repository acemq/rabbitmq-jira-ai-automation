/**
 * Sends an alert via email (Resend) and optionally Slack.
 * Called when a ticket job fails permanently after max retries.
 */
export async function sendAlert(message: string, details?: Record<string, unknown>): Promise<void> {
  await Promise.allSettled([
    sendEmailAlert(message, details),
    sendSlackAlert(message, details),
  ]);
}

async function sendEmailAlert(message: string, details?: Record<string, unknown>): Promise<void> {
  const apiKey = process.env.RESEND_API_KEY;
  const to = process.env.ALERT_EMAIL ?? 'tyler.eastridge@acemq.com';

  if (!apiKey) {
    console.error('[alerting] RESEND_API_KEY not set — email alert suppressed');
    return;
  }

  const body = details
    ? `${message}\n\n${JSON.stringify(details, null, 2)}`
    : message;

  try {
    const res = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        from: 'RabbitMQ Jira Response Failure Alert <alert@alerts.acemq.com>',
        to,
        subject: `[AceMQ] Support AI Alert: ${message.slice(0, 80)}`,
        text: body,
      }),
    });

    if (!res.ok) {
      console.error('[alerting] Resend email failed:', res.status, await res.text());
    } else {
      console.log(`[alerting] Email alert sent to ${to}`);
    }
  } catch (err) {
    console.error('[alerting] Failed to send email alert:', err);
  }
}

async function sendSlackAlert(message: string, details?: Record<string, unknown>): Promise<void> {
  const webhookUrl = process.env.SLACK_ALERT_WEBHOOK_URL;
  if (!webhookUrl) return;

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
