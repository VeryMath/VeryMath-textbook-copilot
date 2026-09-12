import ReactMarkdown, { type Components } from 'react-markdown';
import remarkGfm from 'remark-gfm';
import remarkMath from 'remark-math';
import rehypeKatex from 'rehype-katex';
import type { Book } from '../lib/types';
import MathFormula, { LatexCode, mathText, rehypeMathSource } from './MathFormula';

const mathComponents: Components = {
  span: ({ node, children, ...props }) => typeof node?.properties.dataLatex === 'string'
    ? <MathFormula source={node.properties.dataLatex} display={props.className === 'math-source-block'}>{children}</MathFormula>
    : <span {...props}>{children}</span>,
  pre: ({ node, children, ...props }) => {
    const code = node?.children[0];
    const classes = code?.type === 'element' ? code.properties.className : undefined;
    return code && Array.isArray(classes) && classes.some(name => ['language-latex', 'language-tex'].includes(String(name)))
      ? <LatexCode source={mathText(code).replace(/\n$/, '')}/>
      : <pre {...props}>{children}</pre>;
  },
};

function repairMathFence(content: string) {
  let codeFence = '';
  let mathFence = '';
  return content.split('\n').map(line => {
    const fence = line.match(/^ {0,3}(`{3,}|~{3,})(.*)$/);
    if (codeFence) {
      if (fence && fence[1][0] === codeFence[0] && fence[1].length >= codeFence.length && !fence[2].trim()) codeFence = '';
      return line;
    }
    if (mathFence) {
      // 模型偶尔在公式结束标记后多写一个反引号，避免后续正文被吞进公式。
      const closing = line.match(/^( {0,3})(\${2,})(`?)([\t \r]*)$/);
      if (closing && closing[2].length >= mathFence.length) {
        mathFence = '';
        return `${closing[1]}${closing[2]}${closing[4]}`;
      }
      return line;
    }
    if (fence && (fence[1][0] === '~' || !fence[2].includes('`'))) codeFence = fence[1];
    else mathFence = line.match(/^ {0,3}(\${2,})[\t \r]*$/)?.[1] || '';
    return line;
  }).join('\n');
}

export default function Markdown({ children, book }: { children: string; book?: Book }) {
  // Codex 常用 \(…\) 和 \[…\]；统一成阅读器支持的数学分隔符，并保留代码内容。
  const content = repairMathFence(children).replace(/(`+)[\s\S]*?\1|(~{3,})[\s\S]*?\2|\\\[([\s\S]*?)\\\]|\\\(([\s\S]*?)\\\)/g,
    (match, _backticks, _tildes, block: string | undefined, inline: string | undefined) =>
      block !== undefined ? `\n\n$$\n${block.trim()}\n$$\n\n` : inline !== undefined ? `$${inline}$` : match);
  function courseUrl(value?: string) {
    if (!value || !book?.directory || /^(?:[a-z][a-z0-9+.-]*:|\/\/|#)/i.test(value)) return value;
    const ending = value.search(/[?#]/);
    const suffix = ending < 0 ? '' : value.slice(ending);
    let path;
    try { path = decodeURIComponent(ending < 0 ? value : value.slice(0, ending)); }
    catch { return value; }
    if (path === `${book.directory}/textbook.pdf`) return `${book.url}${suffix}`;
    const referencePrefix = `${book.directory}/references/`;
    const reference = path.startsWith(referencePrefix) ? path.slice(referencePrefix.length)
      : path.startsWith('references/') ? path.slice('references/'.length)
      : path.startsWith('./references/') ? path.slice('./references/'.length) : undefined;
    if (reference !== undefined) {
      const parts = reference.split('/');
      if (parts.length !== 2 || !/^[a-f0-9-]{36}$/.test(parts[0]) || !parts[1] || parts[1] === '.' || parts[1] === '..') return undefined;
      return `/api/courses/${encodeURIComponent(book.id)}/references/${parts[0]}/file${suffix}`;
    }
    const outputs = `${book.directory}/outputs/`;
    const relative = path.startsWith(outputs) ? path.slice(outputs.length) : path.startsWith('outputs/') ? path.slice(8) : path.startsWith('/') ? undefined : path.replace(/^\.\//, '');
    if (!relative) return value;
    if (relative.split('/').some(part => !part || part === '.' || part === '..')) return undefined;
    return `/api/courses/${encodeURIComponent(book.id)}/outputs/${relative.split('/').map(encodeURIComponent).join('/')}${suffix}`;
  }
  return <div className="markdown"><ReactMarkdown remarkPlugins={[remarkGfm, remarkMath]} rehypePlugins={[rehypeMathSource, rehypeKatex]} components={{
    ...mathComponents,
    a: ({ children, href }) => <a href={courseUrl(href)} target="_blank" rel="noreferrer">{children}</a>,
    img: ({ src, alt }) => <img src={courseUrl(src)} alt={alt || ''} loading="lazy" />,
  }}>{content}</ReactMarkdown></div>;
}
