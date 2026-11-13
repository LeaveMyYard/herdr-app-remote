// A safe markdown renderer for the agent's replies: text in, React elements out. There is no HTML anywhere on the
// path (no dangerouslySetInnerHTML, no raw HTML pass-through: tags are shown as text), links keep only http(s) and
// mailto, and every scan is linear or bounded, so a 32 KB reply of nothing but brackets or stars can't stall the
// phone. Supported: paragraphs, #-headings, bullet and numbered lists (nested by indent), fenced code, > quotes,
// rules, simple tables, `code`, **bold**, *italic*, ~~strike~~ and [links](url).
import { memo, type ReactNode } from "react";

/** How far ahead a closing mark is looked for, so one stray opener costs a bounded scan. */
const SPAN = 2000;
const MAX_DEPTH = 6;

/** Only these schemes become links; anything else (javascript:, data:, ...) stays as text. */
export function safeHref(raw: string): string | null {
  const url = raw.trim();
  if (url.length === 0 || url.length > 2000) return null;
  return /^(https?:\/\/|mailto:)[^\s<>"'`]+$/i.test(url) ? url : null;
}

function closer(s: string, mark: string, from: number): number {
  const end = s.indexOf(mark, from);
  return end < 0 || end - from > SPAN ? -1 : end;
}

export function inline(s: string, depth = 0, k = "i"): ReactNode[] {
  const out: ReactNode[] = [];
  let text = "";
  let key = 0;
  const flush = () => {
    if (text) out.push(text);
    text = "";
  };
  const push = (node: ReactNode) => {
    flush();
    out.push(node);
  };
  let i = 0;
  while (i < s.length) {
    const c = s[i] as string;
    if (c === "`") {
      let run = 1;
      while (s[i + run] === "`") run++;
      const mark = "`".repeat(run);
      const end = closer(s, mark, i + run);
      if (end > i + run) {
        push(<code key={`${k}${key++}`}>{s.slice(i + run, end).replace(/^ (.*) $/, "$1")}</code>);
        i = end + run;
        continue;
      }
      text += mark;
      i += run;
      continue;
    }
    if (depth < MAX_DEPTH && (c === "*" || c === "~")) {
      const mark = s.startsWith(c + c, i) ? c + c : c === "*" ? "*" : "";
      if (mark && s[i + mark.length] !== undefined && !/\s/.test(s[i + mark.length] as string)) {
        const end = closer(s, mark, i + mark.length);
        if (end > i + mark.length && !/\s/.test(s[end - 1] as string)) {
          const inner = inline(s.slice(i + mark.length, end), depth + 1, `${k}${key}.`);
          const el = mark === "**" ? <strong key={`${k}${key}`}>{inner}</strong> : mark === "~~" ? <del key={`${k}${key}`}>{inner}</del> : <em key={`${k}${key}`}>{inner}</em>;
          key++;
          push(el);
          i = end + mark.length;
          continue;
        }
      }
    }
    if (depth < MAX_DEPTH && c === "[") {
      const close = closer(s, "](", i + 1);
      const end = close < 0 ? -1 : closer(s, ")", close + 2);
      if (close > i + 1 && end >= 0) {
        const href = safeHref(s.slice(close + 2, end));
        if (href) {
          push(
            <a key={`${k}${key++}`} href={href} target="_blank" rel="noopener noreferrer nofollow">
              {inline(s.slice(i + 1, close), depth + 1, `${k}${key}.`)}
              {/* §5.3: a link is shown with its full URL, so a label can't hide where it goes. */}
              {s.slice(i + 1, close).trim() === href ? null : <span className="md-url">{` ${href}`}</span>}
            </a>,
          );
          i = end + 1;
          continue;
        }
      }
    }
    text += c;
    i++;
  }
  flush();
  return out;
}

// Block markers are recognised by hand or by patterns with no overlapping quantifiers: transcript text is hostile,
// and a run of spaces must cost one pass, not one per split (a lazy `.*?` between `[ \t]*` runs is cubic).
const isSpace = (c: string | undefined) => c === " " || c === "\t";
/** Leading spaces (at most 3) skipped: the index of the first other character, or -1 with 4 or more. */
function indentEnd(l: string): number {
  let i = 0;
  while (i < l.length && l[i] === " ") i++;
  return i > 3 ? -1 : i;
}
function trimEnd(l: string, to = l.length): number {
  let e = to;
  while (e > 0 && isSpace(l[e - 1])) e--;
  return e;
}

/** An opening fence: the mark, its length and a plain info word, else null. */
function fenceOpen(l: string): { mark: string; len: number } | null {
  const i = indentEnd(l);
  if (i < 0) return null;
  const mark = l[i];
  if (mark !== "`" && mark !== "~") return null;
  let j = i;
  while (l[j] === mark) j++;
  if (j - i < 3) return null;
  const info = l.slice(j, trimEnd(l)).trim();
  return /^[A-Za-z0-9_+.-]*$/.test(info) ? { mark, len: j - i } : null;
}
function fenceClose(l: string, mark: string, len: number): boolean {
  const i = indentEnd(l);
  if (i < 0) return false;
  let j = i;
  while (l[j] === mark) j++;
  return j - i >= len && trimEnd(l) <= j;
}
function heading(l: string): { level: number; text: string } | null {
  const i = indentEnd(l);
  if (i < 0 || l[i] !== "#") return null;
  let j = i;
  while (l[j] === "#") j++;
  const level = j - i;
  if (level > 6 || !isSpace(l[j])) return null;
  let end = trimEnd(l);
  // A closing run of #s counts only when a space comes before it.
  let k = end;
  while (k > j && l[k - 1] === "#") k--;
  if (k < end && k > j && isSpace(l[k - 1])) end = trimEnd(l, k);
  return { level, text: l.slice(j, end).trim() };
}
function isRule(l: string): boolean {
  const i = indentEnd(l);
  const c = i < 0 ? undefined : l[i];
  if (c !== "-" && c !== "*" && c !== "_") return false;
  let n = 0;
  for (let j = i; j < l.length; j++) {
    if (l[j] === c) n++;
    else if (!isSpace(l[j])) return false;
  }
  return n >= 3;
}
const ITEM = /^([ \t]*)([-*+]|\d{1,9}[.)])[ \t]+(.*)$/;
const QUOTE = /^ {0,3}>[ \t]?(.*)$/;
const CELL = /^:?-+:?$/;
function isTableSep(l: string): boolean {
  if (!l.includes("-")) return false;
  const t = l.trim();
  const parts = t.replace(/^\|/, "").replace(/\|$/, "").split("|");
  return parts.every((c) => CELL.test(c.trim()));
}

const startsBlock = (l: string) => fenceOpen(l) !== null || heading(l) !== null || isRule(l) || ITEM.test(l) || QUOTE.test(l);

const cells = (l: string): string[] => l.trim().replace(/^\|/, "").replace(/\|$/, "").split("|").map((c) => c.trim());

interface ListNode {
  ordered: boolean;
  items: { text: string[]; kids: ListNode[] }[];
}

function blocks(lines: string[], depth: number, k: string): ReactNode[] {
  const out: ReactNode[] = [];
  let i = 0;
  let key = 0;
  while (i < lines.length) {
    const line = lines[i] as string;
    if (line.trim() === "") {
      i++;
      continue;
    }
    const kk = `${k}${key++}`;
    const fence = fenceOpen(line);
    if (fence) {
      const body: string[] = [];
      i++;
      while (i < lines.length && !fenceClose(lines[i] as string, fence.mark, fence.len)) body.push(lines[i++] as string);
      i++;
      out.push(
        <pre key={kk} className="md-pre">
          <code>{body.join("\n")}</code>
        </pre>,
      );
      continue;
    }
    const h = heading(line);
    if (h) {
      out.push(
        <p key={kk} className="md-h" role="heading" aria-level={Math.min(6, h.level + 2)}>
          {inline(h.text, 0, kk)}
        </p>,
      );
      i++;
      continue;
    }
    if (isRule(line)) {
      out.push(<hr key={kk} className="md-hr" />);
      i++;
      continue;
    }
    if (QUOTE.test(line)) {
      const inner: string[] = [];
      while (i < lines.length && QUOTE.test(lines[i] as string)) {
        inner.push((QUOTE.exec(lines[i] as string) as RegExpExecArray)[1] as string);
        i++;
      }
      out.push(
        <blockquote key={kk} className="md-quote">
          {depth < MAX_DEPTH ? blocks(inner, depth + 1, kk) : inner.join("\n")}
        </blockquote>,
      );
      continue;
    }
    if (ITEM.test(line)) {
      const first = ITEM.exec(line) as RegExpExecArray;
      const indentOf = (m: RegExpExecArray) => (m[1] as string).replace(/\t/g, "    ").length;
      const root: ListNode = { ordered: /\d/.test(first[2] as string), items: [] };
      const stack: { indent: number; list: ListNode }[] = [{ indent: indentOf(first), list: root }];
      while (i < lines.length) {
        const l = lines[i] as string;
        const m = ITEM.exec(l);
        if (!m) {
          // A continuation line, indented under the last item.
          const last = (stack[stack.length - 1] as { list: ListNode }).list.items.at(-1);
          if (last && /^[ \t]+\S/.test(l)) {
            last.text.push(l.trim());
            i++;
            continue;
          }
          break;
        }
        const indent = indentOf(m);
        while (stack.length > 1 && indent < (stack[stack.length - 1] as { indent: number }).indent) stack.pop();
        let top = stack[stack.length - 1] as { indent: number; list: ListNode };
        const parent = top.list.items.at(-1);
        if (indent > top.indent && parent && stack.length < MAX_DEPTH) {
          const kid: ListNode = { ordered: /\d/.test(m[2] as string), items: [] };
          parent.kids.push(kid);
          top = { indent, list: kid };
          stack.push(top);
        }
        top.list.items.push({ text: [m[3] as string], kids: [] });
        i++;
      }
      const render = (n: ListNode, kx: string): ReactNode => {
        const Tag = n.ordered ? "ol" : "ul";
        return (
          <Tag key={kx} className="md-list">
            {n.items.map((it, j) => (
              <li key={j}>
                {inline(it.text.join("\n"), 0, `${kx}.${j}`)}
                {it.kids.map((kid, x) => render(kid, `${kx}.${j}.${x}`))}
              </li>
            ))}
          </Tag>
        );
      };
      out.push(render(root, kk));
      continue;
    }
    if (line.includes("|") && isTableSep(lines[i + 1] ?? "")) {
      const head = cells(line);
      i += 2;
      const rows: string[][] = [];
      while (i < lines.length && (lines[i] as string).includes("|") && (lines[i] as string).trim() !== "") rows.push(cells(lines[i++] as string));
      out.push(
        <div key={kk} className="md-table">
          <table>
            <thead>
              <tr>
                {head.map((c, j) => (
                  <th key={j}>{inline(c, 0, `${kk}h${j}`)}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {rows.map((r, j) => (
                <tr key={j}>
                  {r.map((c, x) => (
                    <td key={x}>{inline(c, 0, `${kk}r${j}.${x}`)}</td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>,
      );
      continue;
    }
    const para: string[] = [line];
    i++;
    while (i < lines.length && (lines[i] as string).trim() !== "" && !startsBlock(lines[i] as string)) para.push(lines[i++] as string);
    const nodes: ReactNode[] = [];
    para.forEach((l, j) => {
      if (j > 0) nodes.push(<br key={`b${j}`} />);
      nodes.push(...inline(l.trim(), 0, `${kk}.${j}`));
    });
    out.push(<p key={kk}>{nodes}</p>);
  }
  return out;
}

/** The reply as elements. */
export const Markdown = memo(function Markdown({ text }: { text: string }) {
  return <div className="md">{blocks(text.replace(/\r\n?/g, "\n").split("\n"), 0, "m")}</div>;
});
