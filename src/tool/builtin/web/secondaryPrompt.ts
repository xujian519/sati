/**
 * Secondary-model prompt builder for `web_fetch` (W13).
 */

export const WEB_FETCH_TOOL_NAME = "web_fetch";

export const WEB_FETCH_DESCRIPTION = `Fetch a URL, convert the page to markdown, and optionally apply \`prompt\` to it with a secondary model. Use it to retrieve and analyze web content.

Usage notes:
  - IMPORTANT: If an MCP-provided web fetch tool is available, prefer using that tool instead of this one, as it may have fewer restrictions.
  - Use mode "raw" for exact, full-text, verification, or copy-the-source tasks where the fetched markdown must not be summarized or rewritten; use the default mode "llm" for summary, question-answering, and analysis tasks.
  - This tool is read-only and does not modify any files.
  - Fetched content may be truncated and model responses may be summarized if the page is very large.
  - Includes a self-cleaning 15-minute cache for faster responses when repeatedly accessing the same URL.
  - When a URL redirects to a different host, the tool will inform you and provide the redirect URL in a special format. You should then make a new web_fetch request with the redirect URL to fetch the content.
  - For GitHub URLs, prefer using the gh CLI via Bash instead (e.g., gh pr view, gh issue view, gh api).`;

export function makeSecondaryModelPrompt(
  markdownContent: string,
  prompt: string,
  isPreapprovedDomain: boolean,
): string {
  const guidelines = isPreapprovedDomain
    ? `Provide a concise response based on the content above. Include relevant details, code examples, and documentation excerpts as needed.`
    : `Provide a concise response based only on the content above. In your response:
 - Enforce a strict 125-character maximum for quotes from any source document. Open Source Software is ok as long as we respect the license.
 - Use quotation marks for exact language from articles; any language outside of the quotation should never be word-for-word the same.
 - You are not a lawyer and never comment on the legality of your own prompts and responses.
 - Never produce or reproduce exact song lyrics.`;

  return `\nWeb page content:\n---\n${markdownContent}\n---\n\n${prompt}\n\n${guidelines}\n`;
}
