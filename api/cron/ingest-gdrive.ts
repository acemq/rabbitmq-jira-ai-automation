import type { VercelRequest, VercelResponse } from '@vercel/node';
import { ingestGdrive } from '../../scripts/ingest-gdrive.js';

export default async function handler(req: VercelRequest, res: VercelResponse) {
  const authHeader = req.headers.authorization;
  if (process.env.CRON_SECRET && authHeader !== `Bearer ${process.env.CRON_SECRET}`) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  const result = await ingestGdrive();
  return res.status(200).json(result);
}
