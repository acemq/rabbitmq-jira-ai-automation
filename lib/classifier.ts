export type ResponseMode = 'solution' | 'diagnostic' | 'non_technical';
export type Confidence = 'high' | 'medium' | 'low';

export interface Classification {
  mode: ResponseMode;
  reason: string;
  confidence: Confidence;
}

/**
 * Parses Claude's XML classification block from its response.
 * Expected format:
 * <classification>
 * mode: solution|diagnostic|non_technical
 * reason: one-line explanation
 * confidence: high|medium|low
 * </classification>
 */
export function parseClassification(claudeOutput: string): Classification {
  const classMatch = claudeOutput.match(
    /<classification>([\s\S]*?)<\/classification>/i
  );

  if (!classMatch) {
    console.warn('[classifier] No <classification> block found — defaulting to diagnostic/low');
    return { mode: 'diagnostic', reason: 'Could not parse classification', confidence: 'low' };
  }

  const block = classMatch[1];

  const modeMatch = block.match(/mode:\s*(solution|diagnostic|non_technical)/i);
  const reasonMatch = block.match(/reason:\s*(.+)/i);
  const confidenceMatch = block.match(/confidence:\s*(high|medium|low)/i);

  const mode = (modeMatch?.[1]?.toLowerCase() as ResponseMode) ?? 'diagnostic';
  const reason = reasonMatch?.[1]?.trim() ?? 'No reason provided';
  const confidence = (confidenceMatch?.[1]?.toLowerCase() as Confidence) ?? 'low';

  return { mode, reason, confidence };
}

/**
 * Extracts the <response> block from Claude's output.
 */
export function parseResponseText(claudeOutput: string): string {
  const responseMatch = claudeOutput.match(/<response>([\s\S]*?)<\/response>/i);
  if (!responseMatch) {
    // Fallback: return the full output if no tags found
    return claudeOutput.trim();
  }
  return responseMatch[1].trim();
}
