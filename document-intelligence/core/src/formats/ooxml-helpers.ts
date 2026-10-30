/** Minimal, dependency-free XML parsing for OOXML parts. Builds a bounded
 *  node tree; supports declarations, comments, CDATA, self-closing tags and
 *  entity decoding. Unknown constructs are skipped, never executed. */

export interface XmlAttrs {
  readonly [key: string]: string;
}
export interface XmlNode {
  readonly tag: string;
  readonly attrs: XmlAttrs;
  readonly children: readonly XmlNode[];
  readonly text: string;
}
export interface FlatNode {
  readonly tag: string;
  readonly attrs: XmlAttrs;
  readonly text: string;
  readonly depth: number;
}

export function parseXml(input: string, maxNodes = 20_000): XmlNode {
  const root: MutableNode = { tag: '#document', attrs: {}, children: [], text: '' };
  const stack: MutableNode[] = [root];
  let i = 0;
  let nodes = 0;
  while (i < input.length) {
    const lt = input.indexOf('<', i);
    if (lt === -1) {
      appendText(stack, input.slice(i));
      break;
    }
    if (lt > i) appendText(stack, input.slice(i, lt));
    const gt = input.indexOf('>', lt);
    if (gt === -1) break;
    const raw = input.slice(lt + 1, gt);
    if (raw.startsWith('?') || raw.startsWith('!')) {
      i = gt + 1;
      continue;
    }
    if (raw.startsWith('/')) {
      if (stack.length > 1) stack.pop();
      i = gt + 1;
      continue;
    }
    const selfClose = raw.endsWith('/');
    const body = selfClose ? raw.slice(0, -1) : raw;
    const space = body.search(/[\s]/);
    const tag = space === -1 ? body : body.slice(0, space);
    const attrs = parseAttrs(space === -1 ? '' : body.slice(space));
    if (!tag || /[^\w:.-]/.test(tag)) {
      i = gt + 1;
      continue;
    }
    const node: MutableNode = { tag, attrs, children: [], text: '' };
    stack[stack.length - 1]?.children.push(node);
    nodes += 1;
    if (nodes > maxNodes) break;
    if (!selfClose) stack.push(node);
    i = gt + 1;
  }
  return root;
}

interface MutableNode {
  tag: string;
  attrs: XmlAttrs;
  children: MutableNode[];
  text: string;
}

function appendText(stack: MutableNode[], text: string): void {
  const current = stack[stack.length - 1];
  if (current) current.text += decodeEntities(text);
}

function parseAttrs(source: string): XmlAttrs {
  const out: Record<string, string> = {};
  const re = /([\w:.-]+)\s*=\s*("([^"]*)"|'([^']*)')/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(source)) !== null) {
    const key = m[1];
    const value = m[3] ?? m[4] ?? '';
    if (key) out[key] = decodeEntities(value);
    if (Object.keys(out).length >= 50) break;
  }
  return out;
}

export function decodeEntities(input: string): string {
  let s = input;
  s = s.replace(/&#(\d+);/g, (_, d) => safeChar(Number(d)));
  s = s.replace(/&#x([0-9a-fA-F]+);/g, (_, h) => safeChar(Number.parseInt(h, 16)));
  s = s.replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>');
  s = s.replace(/&quot;/g, '"').replace(/&apos;/g, "'");
  return s;
}

function safeChar(code: number): string {
  if (!Number.isFinite(code) || (code < 0x20 && code !== 0x9 && code !== 0xa && code !== 0xd))
    return '';
  try {
    return String.fromCodePoint(code);
  } catch {
    return '';
  }
}

/** Depth-first flatten; good enough for parts where order matters. */
export function flatParse(input: string, maxNodes = 20_000): readonly FlatNode[] {
  const root = parseXml(input, maxNodes);
  const out: FlatNode[] = [];
  const walk = (node: MutableNode, depth: number): void => {
    for (const child of node.children) {
      out.push({ tag: child.tag, attrs: child.attrs, text: child.text, depth });
      if (out.length >= maxNodes) return;
      walk(child, depth + 1);
    }
  };
  walk(root as unknown as MutableNode, 0);
  return out;
}

/** Ordered traversal preserving document order of direct descent. */
export function orderedParse(input: string, maxNodes = 20_000): readonly XmlNode[] {
  const root = parseXml(input, maxNodes);
  const out: XmlNode[] = [];
  const walk = (node: MutableNode): void => {
    for (const child of node.children) {
      out.push(child as unknown as XmlNode);
      if (out.length >= maxNodes) return;
      walk(child);
    }
  };
  walk(root as unknown as MutableNode);
  return out;
}

export function tagOf(node: XmlNode): string {
  return node.tag;
}

export function textOf(node: XmlNode): string {
  return node.text.trim();
}

export function attrsOf(node: XmlNode): XmlAttrs {
  return node.attrs;
}

export function childrenOf(node: XmlNode, tag?: string): readonly XmlNode[] {
  return node.children.filter((c) => !tag || c.tag === tag);
}

export function findAll(root: XmlNode, tag: string, max = 5000): readonly XmlNode[] {
  const out: XmlNode[] = [];
  const walk = (node: XmlNode): void => {
    if (out.length >= max) return;
    for (const child of node.children) {
      if (child.tag === tag) out.push(child);
      if (out.length >= max) return;
      walk(child);
    }
  };
  walk(root);
  return out;
}

export function findAllDeep(nodes: readonly FlatNode[], tag: string): readonly FlatNode[] {
  return nodes.filter((n) => n.tag === tag);
}

export function findFirst(root: XmlNode, tag: string): XmlNode | null {
  const all = findAll(root, tag, 1);
  return all.length > 0 ? (all[0] as XmlNode) : null;
}
