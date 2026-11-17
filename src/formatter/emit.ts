/**
 * 行发射器：拼行、缩进、行宽，持有最终输出的行数组。
 * 不了解任何 jq 语法 —— 断行与展开决策全部在 layout.ts。
 */

/**
 * 去掉行尾空白；但当剩余部分以奇数个反斜杠结尾时保留一个空格：
 * 若去掉，下一行输出会被 jq 当作注释续行，静默注释掉后面的代码。
 */
export function trimLineEnd(s: string): string {
  const t = s.replace(/\s+$/, '')
  if (t !== s && /(?:^|[^\\])(?:\\{2})*\\$/.test(t)) return t + ' '
  return t
}

export class LineBuilder {
  readonly #lines: string[] = []
  #cur = ''
  /** 当前行的缩进列数（空格数，不一定是 indentSize 的倍数 ——
   * 行中开括号的列对齐会落在任意列上） */
  #curIndent = 0

  /** 当前行已写到的列（含缩进），供行宽判断使用 */
  col(): number {
    return this.#curIndent + this.#cur.length
  }

  /** 当前行是否已有内容 */
  get hasContent(): boolean {
    return this.#cur !== ''
  }

  /** 正在拼的当前行的缩进列数 */
  get indentCols(): number {
    return this.#curIndent
  }

  /** 另起一行，缩进 cols 列（之前未结束的当前行需先 finishLine） */
  startLine(cols: number): void {
    this.#cur = ''
    this.#curIndent = cols
  }

  /** 结束当前行（去行尾空白）落入输出 */
  finishLine(): void {
    this.#lines.push(this.#indentStr(this.#curIndent) + trimLineEnd(this.#cur))
    this.#cur = ''
  }

  /** 追加一段文本；space 为 true 且当前行非空时补一个空格 */
  append(text: string, space: boolean): void {
    if (space && this.#cur !== '') this.#cur += ' '
    this.#cur += text
  }

  /** 行尾注释：与代码之间按源码间距保留 spaces 个空格（当前行为空时直接开始） */
  appendTrailingComment(text: string, spaces: number): void {
    if (this.#cur === '') this.#cur = text
    else this.#cur += ' '.repeat(spaces) + text
  }

  /**
   * 独立成行的内容（注释）：先结束未完的当前行，再以 cols 列缩进
   * 直接落入输出，并从这里继续拼下一行。
   */
  addStandaloneLine(cols: number, text: string): void {
    if (this.#cur !== '') this.finishLine()
    this.#lines.push(this.#indentStr(cols) + text)
    this.startLine(cols)
  }

  /** 已输出的最后一行；还没有任何输出时为 undefined */
  lastLine(): string | undefined {
    return this.#lines[this.#lines.length - 1]
  }

  /** 补 n 个空行（用于保留源码中的空行） */
  addBlankLines(n: number): void {
    for (let k = 0; k < n; k++) this.#lines.push('')
  }

  /** 去掉末尾连续的空行 */
  trimTrailingBlankLines(): void {
    while (this.#lines.length > 0 && this.#lines[this.#lines.length - 1] === '') this.#lines.pop()
  }

  /** 以指定换行符连接全部输出行 */
  join(eol: string): string {
    return this.#lines.join(eol)
  }

  #indentStr(cols: number): string {
    return ' '.repeat(cols)
  }
}
