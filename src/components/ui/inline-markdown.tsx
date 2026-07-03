import type { ReactNode } from "react";

export function renderInlineMarkdown(text: string): ReactNode[] {
  const nodes: ReactNode[] = [];
  const markdownPattern = /(\[[^\]\n]+?\]\((?:https?:\/\/|\/)[^)\s]+?\)|`[^`\n]+?`|\*\*[^*\n]+?\*\*|__[^_\n]+?__|\*[^*\n]+?\*|_[^_\n]+?_)/g;
  let lastIndex = 0;
  let match: RegExpExecArray | null;

  while ((match = markdownPattern.exec(text)) !== null) {
    const token = match[0];
    const start = match.index;

    if (start > lastIndex) {
      nodes.push(text.slice(lastIndex, start));
    }

    if (token.startsWith("[") && token.includes("](")) {
      const labelEnd = token.indexOf("](");
      const label = token.slice(1, labelEnd);
      const href = token.slice(labelEnd + 2, -1);
      const isExternal = href.startsWith("http://") || href.startsWith("https://");

      nodes.push(
        <a
          key={`${start}-link`}
          className="font-medium text-[var(--accent)] underline decoration-[var(--accent)]/30 underline-offset-2 hover:decoration-[var(--accent)]"
          href={href}
          rel={isExternal ? "noreferrer" : undefined}
          target={isExternal ? "_blank" : undefined}
        >
          {label}
        </a>,
      );
    } else if (token.startsWith("`")) {
      nodes.push(
        <code key={`${start}-code`} className="rounded-sm bg-[var(--bg-muted)] px-1 py-0.5 text-[0.92em] text-[var(--foreground)]">
          {token.slice(1, -1)}
        </code>,
      );
    } else if (token.startsWith("**") || token.startsWith("__")) {
      nodes.push(
        <strong key={`${start}-strong`} className="font-semibold text-[var(--foreground)]">
          {token.slice(2, -2)}
        </strong>,
      );
    } else {
      nodes.push(
        <em key={`${start}-em`} className="italic text-[var(--foreground)]">
          {token.slice(1, -1)}
        </em>,
      );
    }

    lastIndex = start + token.length;
  }

  if (lastIndex < text.length) {
    nodes.push(text.slice(lastIndex));
  }

  return nodes;
}
