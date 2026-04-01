/**
 * Converts Atlassian Document Format (ADF) JSON to plain text.
 * Used to extract searchable text from Jira ticket descriptions.
 */

interface AdfNode {
  type: string;
  text?: string;
  content?: AdfNode[];
  attrs?: Record<string, unknown>;
}

export function adfToPlaintext(adf: unknown): string {
  if (!adf || typeof adf !== 'object') return '';

  const node = adf as AdfNode;

  // Leaf text node
  if (node.type === 'text' && typeof node.text === 'string') {
    return node.text;
  }

  const children = node.content ?? [];
  const childText = children.map(adfToPlaintext).join('');

  switch (node.type) {
    case 'paragraph':
    case 'heading':
      return `${childText}\n`;
    case 'hardBreak':
      return '\n';
    case 'bulletList':
    case 'orderedList':
      return `${childText}\n`;
    case 'listItem':
      return `- ${childText}`;
    case 'codeBlock':
      return `\n${childText}\n`;
    case 'blockquote':
      return `> ${childText}`;
    case 'rule':
      return '\n---\n';
    default:
      return childText;
  }
}
