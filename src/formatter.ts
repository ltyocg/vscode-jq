/**
 * Formatter for jq programs.
 *
 * A whitespace-only, structure-aware pretty printer built on the jq grammar
 * (jqlang/jq src/parser.y). It never changes token text — it only decides
 * spacing, line breaks and indentation.
 *
 * Style rules:
 *  - indentSize spaces per indentation level (default 2)
 *  - pipelines break with a leading '|' on the next line, indented +1,
 *    when the source had a break there or the line would exceed printWidth
 *  - object/array/paren groups expand (one element per line) when the
 *    source had a line break inside them, when they contain comments,
 *    or when they do not fit within printWidth
 *  - the user's line breaks are preserved at legal break points
 *    (after ';', around 'def', around if/try clauses, before '|')
 *    and collapsed everywhere else
 *  - comments are kept: standalone comments stay on their own line,
 *    trailing comments stay trailing
 */

import { Token, tokenize, matchBrackets, LexError } from './tokenizer';

export interface FormatOptions {
  /** maximum line length before the formatter starts breaking lines */
  printWidth: number;
  /** spaces per indentation level */
  indentSize: number;
}

export const defaultFormatOptions: FormatOptions = { printWidth: 80, indentSize: 2 };

export class FormatError extends Error {}

const CLAUSE_KEYWORDS = new Set(['then', 'elif', 'else', 'end', 'catch']);
const OPENERS = new Set(['(', '[', '{']);
const CLOSERS = new Set([')', ']', '}']);
const BINOPS = new Set([
  '|', '//', '?//', '==', '!=', '<', '<=', '>', '>=',
  '+', '-', '*', '/', '%', '=', '|=', '+=', '-=', '*=', '/=', '%=', '//=',
]);

function countNewlines(s: string): number {
  let n = 0;
  for (let i = s.indexOf('\n'); i >= 0; i = s.indexOf('\n', i + 1)) n++;
  return n;
}

/**
 * True when tokens[k] is a keyword used as an object key, as in
 * `{if: 1, end: 2}` — jq reserves the words but still allows them as
 * keys. Such a keyword must not trigger clause breaks or clause state:
 * `{if: ...}` opens no if-context, `{end: ...}` closes none, and
 * `{def: ...}` is not a definition. A clause keyword is never legally
 * followed by ':' otherwise, so this lookahead is unambiguous.
 */
function isObjectKey(tokens: Token[], k: number): boolean {
  const t = tokens[k];
  const n = tokens[k + 1];
  return t.type === 'keyword' && !!n && n.type === 'operator' && n.text === ':';
}

/**
 * Trim trailing whitespace from a rendered line — except that one space is
 * kept when what remains ends with an odd run of backslashes. Dropping it
 * would turn the following output line into a jq comment continuation
 * and silently comment out code.
 */
function trimLineEnd(s: string): string {
  const t = s.replace(/\s+$/, '');
  if (t !== s && /(?:^|[^\\])(?:\\{2})*\\$/.test(t)) return t + ' ';
  return t;
}

/** Tokens that can end an operand, so a following '.' or '[' binds tightly. */
function isOperandEnd(t: Token | undefined): boolean {
  if (!t) return false;
  switch (t.type) {
    case 'ident':
    case 'number':
    case 'string':
    case 'variable':
    case 'format':
    case 'constant':
      return true;
    case 'operator':
      return t.text === ')' || t.text === ']' || t.text === '}' || t.text === '?';
    default:
      return false;
  }
}

/** True when a '-' following `t` must be unary. */
function isPrefixPosition(t: Token | undefined): boolean {
  if (!t) return true; // start of file
  if (t.type === 'operator') {
    return OPENERS.has(t.text) || t.text === ',' || t.text === ';' ||
      t.text === ':' || t.text === '$' || BINOPS.has(t.text);
  }
  if (t.type === 'keyword') return t.text !== 'end'; // `end - 1` is binary
  return false;
}

/**
 * Horizontal gap between two adjacent tokens on one line.
 * `enclosing` is the innermost open bracket character ('(', '[' or '{'),
 * or '' at statement level — distinguishes object colons ('{a: 1}')
 * from slice colons ('.[2:5]').
 */
function gapBetween(prev: Token, next: Token, enclosing: string): 'none' | 'space' {
  // 1. nothing before closers / separators / postfix '?' / colons
  if (next.type === 'operator' &&
      (CLOSERS.has(next.text) || next.text === ',' || next.text === ';' ||
       next.text === '?' || next.text === ':')) {
    return 'none';
  }
  // 2. nothing directly after an opener
  if (prev.type === 'operator' && OPENERS.has(prev.text)) return 'none';
  // 3. after a dot: '.foo', '."foo"', '.['
  if (prev.type === 'operator' && (prev.text === '.' || prev.text === '..')) {
    if (next.type === 'ident' || next.type === 'string' ||
        (next.type === 'operator' && next.text === '[')) {
      return 'none';
    }
    return 'space';
  }
  // 4. unary minus attaches to its operand: '-1', '-(.a)', '-.score'
  if (prev.type === 'operator' && prev.text === '-' && prev.unary) return 'none';
  // 5. field / index chains bind tightly: '.a.b', '(.f).g', 'first[0]', '$x[0]'
  if (next.type === 'operator' && (next.text === '.' || next.text === '[' || next.text === '..')) {
    return isOperandEnd(prev) ? 'none' : 'space';
  }
  // 6. function call syntax: 'map('
  if (next.type === 'operator' && next.text === '(' && prev.type === 'ident') {
    return 'none';
  }
  // 7. colon spacing: '{a: 1}' and 'def f: ...' vs slices '.[2:5]'
  if (prev.type === 'operator' && prev.text === ':') {
    return enclosing === '[' ? 'none' : 'space';
  }
  // 8. lone '$' prefixes (the $$$$name hack from jq's builtin.jq)
  if (prev.type === 'operator' && prev.text === '$') return 'none';
  if (next.type === 'operator' && next.text === '$' &&
      prev.type === 'operator' && prev.text === '$') {
    return 'none';
  }
  return 'space';
}

interface GroupCtx {
  kind: '(' | '[' | '{';
  expanded: boolean;
  /** ctxIndent to restore when the group closes */
  savedIndent: number;
  /**
   * Indent level of the line the opener was emitted on. An expanded
   * group puts its closer on this line's level — after a pipe break
   * that line is one deeper than ctxIndent, and contents/closer must
   * follow it, not the pre-pipe context.
   */
  closeIndent: number;
}

interface ClauseCtx {
  kind: 'if' | 'try';
  /** indent level of the line where 'if'/'try' was emitted */
  indent: number;
}

export function formatJq(src: string, options?: Partial<FormatOptions>): string {
  if (src.trim() === '') return src;
  const opts = { ...defaultFormatOptions, ...options };

  let tokens: Token[];
  let match: Map<number, number>;
  try {
    tokens = tokenize(src);
    match = matchBrackets(tokens);
  } catch (e) {
    if (e instanceof LexError) throw new FormatError(`cannot format: ${e.message}`);
    throw e;
  }
  if (tokens.length === 0) return src;

  // Annotate unary minus so every gap decision agrees.
  {
    let prev: Token | undefined;
    for (const t of tokens) {
      if (t.type === 'comment') continue;
      if (t.type === 'operator' && t.text === '-') {
        t.unary = isPrefixPosition(prev);
      }
      prev = t;
    }
  }

  const eol = src.includes('\r\n') ? '\r\n' : '\n';

  // -- emitter state --------------------------------------------------------
  const lines: string[] = [];
  let cur = '';
  let curLineIndent = 0; // indent level of the line being built
  let ctxIndent = 0; // indent level for new lines in the current context

  const indentStr = (levels: number) => ' '.repeat(levels * opts.indentSize);
  const col = () => curLineIndent * opts.indentSize + cur.length;
  const startLine = (levels: number) => {
    cur = '';
    curLineIndent = levels;
  };
  const finishLine = () => {
    lines.push(indentStr(curLineIndent) + trimLineEnd(cur));
    cur = '';
  };

  // -- parser-ish state ------------------------------------------------------
  const groupStack: GroupCtx[] = [];
  const clauseStack: ClauseCtx[] = [];
  const defStack: { depth: number; savedIndent: number }[] = [];
  let pendingDef = false;
  let defPendingDepth = 0;
  let lastColonWasDef = false;
  let pendingForcedBreak = false;
  let prevReal: Token | undefined;
  let lastRealEndLine = -1;
  let lastAnyEndLine = -1;

  // -- width measurement helpers ---------------------------------------------

  /** Render tokens[start, end) on one line; null if it contains a comment. */
  function flatSpan(start: number, end: number, hint: string): string | null {
    let out = '';
    const stack: string[] = [];
    for (let k = start; k < end; k++) {
      const tk = tokens[k];
      if (tk.type === 'comment') return null;
      const prev = k > start ? tokens[k - 1] : undefined;
      const enclosing = stack.length ? stack[stack.length - 1] : hint;
      const g = prev ? gapBetween(prev, tk, enclosing) : 'none';
      if (g === 'space') out += ' ';
      out += tk.text;
      if (tk.type === 'operator' && OPENERS.has(tk.text)) stack.push(tk.text);
      else if (tk.type === 'operator' && CLOSERS.has(tk.text)) stack.pop();
    }
    return out;
  }

  /** First token index at/after j that is a legal break point. */
  function findSegmentEnd(j: number): number {
    let depth = 0;
    const cap = Math.min(tokens.length, j + 200);
    for (let k = j; k < cap; k++) {
      const tk = tokens[k];
      if (k > j) {
        if (tk.type === 'comment') return k; // a comment always ends its line
        if (depth === 0) {
          if (tk.type === 'operator' &&
              (tk.text === '|' || tk.text === ';' || tk.text === ',' || CLOSERS.has(tk.text))) {
            return k;
          }
          if (tk.type === 'keyword' &&
              (CLAUSE_KEYWORDS.has(tk.text) || tk.text === 'def') &&
              !isObjectKey(tokens, k)) {
            return k;
          }
        }
      }
      if (tk.type === 'operator' && OPENERS.has(tk.text)) depth++;
      else if (tk.type === 'operator' && CLOSERS.has(tk.text)) depth--;
    }
    return tokens.length;
  }

  function segmentWidth(j: number): number {
    // Leading comments trail the current line and do not count towards
    // the width of the segment that follows them.
    let start = j;
    while (start < tokens.length && tokens[start].type === 'comment') start++;
    const flat = flatSpan(start, findSegmentEnd(start), '');
    return flat === null ? Infinity : flat.length;
  }

  function pipeOverflow(i: number): boolean {
    const seg = segmentWidth(i + 1);
    return seg === Infinity || col() + 3 + seg > opts.printWidth;
  }

  function clauseOverflow(i: number): boolean {
    const t = tokens[i];
    if (t.text !== 'then' && t.text !== 'elif' && t.text !== 'else') return false;
    const seg = segmentWidth(i + 1);
    return seg === Infinity || col() + t.text.length + 1 + seg > opts.printWidth;
  }

  /** Should the group opened at token i be laid out across multiple lines? */
  function decideExpanded(i: number): boolean {
    const close = match.get(i)!;
    if (close === i + 1) return false; // empty group
    let prevEnd = tokens[i].line;
    for (let k = i + 1; k < close; k++) {
      const tk = tokens[k];
      if (tk.line > prevEnd) return true; // line break inside
      if (tk.type === 'comment') return true;
      prevEnd = tk.line + countNewlines(tk.text);
    }
    if (tokens[close].line > prevEnd) return true;
    const flat = flatSpan(i + 1, close, tokens[i].text);
    if (flat === null) return true;
    return col() + flat.length + 1 > opts.printWidth;
  }

  function findClauseIndent(kind: 'if' | 'try'): number | null {
    for (let p = clauseStack.length - 1; p >= 0; p--) {
      if (clauseStack[p].kind === kind) return clauseStack[p].indent;
    }
    return null;
  }

  function popClause(kind: 'if' | 'try'): void {
    for (let p = clauseStack.length - 1; p >= 0; p--) {
      if (clauseStack[p].kind === kind) {
        clauseStack.length = p;
        return;
      }
    }
  }

  // -- main walk --------------------------------------------------------------

  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i];

    if (t.type === 'comment') {
      const text = trimLineEnd(t.text);
      if (t.line === lastAnyEndLine && lastAnyEndLine >= 0) {
        // trailing comment: stays on the current line
        cur += (cur === '' ? '' : '  ') + text;
        pendingForcedBreak = true; // the comment consumed the rest of the line
      } else {
        // standalone comment: own line at the current indent
        if (cur !== '') finishLine();
        lines.push(indentStr(ctxIndent) + text);
        startLine(ctxIndent);
      }
      // A continued comment (odd trailing backslashes) spans several lines.
      lastAnyEndLine = t.line + countNewlines(t.text);
      continue;
    }

    // Gap since the last code token. When the file starts with comments
    // (no code token yet), measure from the last comment instead, so a
    // blank line between a leading comment block and the first def
    // survives formatting instead of being silently dropped.
    const nl = prevReal
      ? t.line - lastRealEndLine
      : lastAnyEndLine >= 0
        ? t.line - lastAnyEndLine
        : 0;
    const forced = pendingForcedBreak;
    pendingForcedBreak = false;

    const innerGroup = groupStack[groupStack.length - 1];
    const inlineInnermost = groupStack.length > 0 && !innerGroup!.expanded;

    // `{if: 1}` — keyword as object key, not a clause/def keyword.
    const objectKey = isObjectKey(tokens, i);

    // -- break decision (first match wins) --
    let breakLevels: number | null = null;
    let blank = false;

    if (t.type === 'operator') {
      if (t.text === '|') {
        if (!inlineInnermost && (nl > 0 || pipeOverflow(i))) {
          breakLevels = ctxIndent + 1;
        }
      } else if (CLOSERS.has(t.text)) {
        if (innerGroup && innerGroup.expanded) breakLevels = innerGroup.closeIndent;
      }
    } else if (t.type === 'keyword' && !objectKey) {
      if (CLAUSE_KEYWORDS.has(t.text)) {
        if (!inlineInnermost && (nl > 0 || clauseOverflow(i))) {
          breakLevels = findClauseIndent(
            t.text === 'catch' ? 'try' : 'if',
          ) ?? ctxIndent;
        }
      } else if (t.text === 'def' && i > 0) {
        breakLevels = ctxIndent;
        blank = nl >= 2;
      }
    }

    if (breakLevels === null && prevReal) {
      const p = prevReal;
      if (p.type === 'operator') {
        if (p.text === ';') {
          if (groupStack.length === 0) {
            breakLevels = ctxIndent;
            blank = nl >= 2;
          } else if (groupStack[groupStack.length - 1]!.expanded) {
            breakLevels = ctxIndent;
          }
        } else if (p.text === ',') {
          if (groupStack.length === 0) {
            if (nl > 0) breakLevels = ctxIndent;
          } else if (groupStack[groupStack.length - 1]!.expanded) {
            breakLevels = ctxIndent;
          }
        } else if (p.text === ':' && lastColonWasDef) {
          if (nl > 0 && groupStack.every((g) => g.expanded)) breakLevels = ctxIndent;
        } else if (OPENERS.has(p.text)) {
          if (groupStack[groupStack.length - 1]?.expanded) breakLevels = ctxIndent;
        }
      }
    }

    if (breakLevels === null && forced) {
      // Continue a pipeline at pipe level when the comment trailed a '|'.
      breakLevels = prevReal && prevReal.type === 'operator' && prevReal.text === '|'
        ? ctxIndent + 1
        : ctxIndent;
    }

    // -- emit --
    if (breakLevels !== null) {
      if (cur !== '') finishLine();
      if (blank && lines.length > 0 && lines[lines.length - 1] !== '') lines.push('');
      startLine(breakLevels);
      cur = t.text;
    } else {
      const enclosing = groupStack.length ? groupStack[groupStack.length - 1]!.kind : '';
      const g = prevReal ? gapBetween(prevReal, t, enclosing) : 'none';
      if (g === 'space' && cur !== '') cur += ' ';
      cur += t.text;
    }

    // -- post-emit bookkeeping --
    if (t.type === 'operator') {
      if (OPENERS.has(t.text)) {
        const expanded = decideExpanded(i);
        groupStack.push({
          kind: t.text as '(' | '[' | '{',
          expanded,
          savedIndent: ctxIndent,
          closeIndent: curLineIndent,
        });
        if (expanded) {
          ctxIndent = curLineIndent + 1;
          pendingForcedBreak = true;
        }
      } else if (CLOSERS.has(t.text)) {
        const g = groupStack.pop();
        if (g) ctxIndent = g.savedIndent;
      } else if (t.text === ':') {
        if (pendingDef && groupStack.length === defPendingDepth) {
          defStack.push({ depth: defPendingDepth, savedIndent: ctxIndent });
          ctxIndent++;
          lastColonWasDef = true;
          pendingDef = false;
        } else {
          lastColonWasDef = false;
        }
      } else if (t.text === ';') {
        if (defStack.length > 0 &&
            defStack[defStack.length - 1]!.depth === groupStack.length) {
          ctxIndent = defStack.pop()!.savedIndent;
        }
      }
    } else if (t.type === 'keyword' && !objectKey) {
      if (t.text === 'def') {
        // Only a real definition: 'def' IDENT (':' | '(' ...)
        const n1 = tokens[i + 1];
        const n2 = tokens[i + 2];
        pendingDef = !!n1 && n1.type === 'ident' && !!n2 && n2.type === 'operator' &&
          (n2.text === ':' || n2.text === '(');
        defPendingDepth = groupStack.length;
      } else if (t.text === 'if') {
        clauseStack.push({ kind: 'if', indent: curLineIndent });
      } else if (t.text === 'try') {
        clauseStack.push({ kind: 'try', indent: curLineIndent });
      } else if (t.text === 'end') {
        popClause('if');
      } else if (t.text === 'catch') {
        popClause('try');
      }
    }

    prevReal = t;
    lastRealEndLine = t.line + countNewlines(t.text);
    lastAnyEndLine = lastRealEndLine;
  }

  if (cur !== '') finishLine();
  while (lines.length > 0 && lines[lines.length - 1] === '') lines.pop();
  return lines.join(eol) + eol;
}
