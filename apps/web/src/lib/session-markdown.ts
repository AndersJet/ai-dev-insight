import MarkdownIt from 'markdown-it';

// No raw HTML, remote image loading, plugins or automatic link detection.
const parser = new MarkdownIt({ html: false, linkify: false, typographer: false, maxNesting: 20 });
parser.validateLink = value => {
  try {
    const url = new URL(value);
    return ['https:', 'http:'].includes(url.protocol) && !url.username && !url.password;
  } catch { return false; }
};
parser.renderer.rules.image = (tokens, index) => `<span class="markdown-image-note">[图片：${parser.utils.escapeHtml(tokens[index]!.content || '未提供说明')}]</span>`;
parser.renderer.rules.link_open = (tokens, index, options, _environment, renderer) => {
  const token = tokens[index]!;
  token.attrSet('target', '_blank');
  token.attrSet('rel', 'noopener noreferrer');
  token.attrSet('referrerpolicy', 'no-referrer');
  return renderer.renderToken(tokens, index, options);
};

/** Only the bounded prompt/response reading window is passed to this renderer. */
export function renderSessionMarkdown(text: string): string {
  return parser.render(text);
}
