import type { VercelRequest, VercelResponse } from '@vercel/node';
import { ingestRmqDocs } from '../../scripts/ingest-rmq-docs.js';

export default async function handler(req: VercelRequest, res: VercelResponse) {
  const authHeader = req.headers.authorization;
  if (process.env.CRON_SECRET && authHeader !== `Bearer ${process.env.CRON_SECRET}`) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  const result = await ingestRmqDocs();
  return res.status(200).json(result);
}
