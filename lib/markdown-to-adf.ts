/**
 * Converts markdown text (as produced by Claude) to Atlassian Document Format (ADF).
 * Handles: paragraphs, bold, italic, inline code, code blocks, bullet lists,
 * numbered lists, headings (H1–H3), and horizontal rules.
 */

type AdfNode = Record<string, unknown>;

function textNode(text: string): AdfNode {
  return { type: 'text', text };
}

function markedText(text: string, marks: AdfNode[]): AdfNode {
  return { type: 'text', text, marks };
}

/** Parse inline markdown within a single line into ADF text nodes. */
function parseInline(line: string): AdfNode[] {
  const nodes: AdfNode[] = [];
  // Regex matches: **bold**, *italic*, `code`, or plain text
  const pattern = /(`[^`]+`|\*\*[^*]+\*\*|\*[^*]+\*|[^`*]+)/g;
  let match: RegExpExecArray | null;

  while ((match = pattern.exec(line)) !== null) {
    const token = match[0];
    if (!token) continue;

    if (token.startsWith('`') && token.endsWith('`')) {
      const inner = token.slice(1, -1);
      nodes.push(markedText(inner, [{ type: 'code' }]));
    } else if (token.startsWith('**') && token.endsWith('**')) {
      const inner = token.slice(2, -2);
      nodes.push(markedText(inner, [{ type: 'strong' }]));
    } else if (token.startsWith('*') && token.endsWith('*')) {
      const inner = token.slice(1, -1);
      nodes.push(markedText(inner, [{ type: 'em' }]));
    } else {
      nodes.push(textNode(token));
    }
  }

  return nodes.length > 0 ? nodes : [textNode(line)];
}

function paragraph(content: AdfNode[]): AdfNode {
  return { type: 'paragraph', content };
}

function heading(level: number, content: AdfNode[]): AdfNode {
  return { type: 'heading', attrs: { level }, content };
}

function bulletList(items: AdfNode[][]): AdfNode {
  return {
    type: 'bulletList',
    content: items.map((c) => ({
      type: 'listItem',
      content: [paragraph(c)],
    })),
  };
}

function orderedList(items: AdfNode[][]): AdfNode {
  return {
    type: 'orderedList',
    content: items.map((c) => ({
      type: 'listItem',
      content: [paragraph(c)],
    })),
  };
}

function codeBlock(code: string, language?: string): AdfNode {
  const node: AdfNode = {
    type: 'codeBlock',
    attrs: language ? { language } : {},
    content: [{ type: 'text', text: code }],
  };
  return node;
}

function rule(): AdfNode {
  return { type: 'rule' };
}

export function markdownToAdf(markdown: string): AdfNode {
  const lines = markdown.split('\n');
  const content: AdfNode[] = [];

  let i = 0;

  while (i < lines.length) {
    const line = lines[i];

    // Fenced code block
    const codeFenceMatch = line.match(/^```(\w*)$/);
    if (codeFenceMatch) {
      const lang = codeFenceMatch[1] || undefined;
      const codeLines: string[] = [];
      i++;
      while (i < lines.length && !lines[i].startsWith('```')) {
        codeLines.push(lines[i]);
        i++;
      }
      content.push(codeBlock(codeLines.join('\n'), lang));
      i++; // skip closing ```
      continue;
    }

    // Horizontal rule
    if (/^[-*_]{3,}$/.test(line.trim())) {
      content.push(rule());
      i++;
      continue;
    }

    // Headings
    const headingMatch = line.match(/^(#{1,3})\s+(.+)$/);
    if (headingMatch) {
      const level = headingMatch[1].length;
      content.push(heading(level, parseInline(headingMatch[2])));
      i++;
      continue;
    }

    // Bullet list
    if (/^[-*+]\s/.test(line)) {
      const items: AdfNode[][] = [];
      while (i < lines.length && /^[-*+]\s/.test(lines[i])) {
        items.push(parseInline(lines[i].replace(/^[-*+]\s+/, '')));
        i++;
      }
      content.push(bulletList(items));
      continue;
    }

    // Numbered list
    if (/^\d+\.\s/.test(line)) {
      const items: AdfNode[][] = [];
      while (i < lines.length && /^\d+\.\s/.test(lines[i])) {
        items.push(parseInline(lines[i].replace(/^\d+\.\s+/, '')));
        i++;
      }
      content.push(orderedList(items));
      continue;
    }

    // Blank line — skip
    if (line.trim() === '') {
      i++;
      continue;
    }

    // Regular paragraph
    content.push(paragraph(parseInline(line)));
    i++;
  }

  return {
    version: 1,
    type: 'doc',
    content,
  };
}
