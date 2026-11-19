/**
 * 公共 API：选项与错误类型。
 * 独立成叶子模块（不依赖其他 formatter 文件），供入口层与布局层
 * 共同引用，避免循环依赖。
 */

/**
 * 对象构造尾随逗号策略 —— jq 语法中对象构造是尾随逗号唯一合法的位置
 * （数组、函数实参、解构模式均不允许），策略只作用于那里：
 *  - 'never'     一律去掉（默认）；
 *  - 'multiline' 展开为多行的对象在末条目后补齐尾随逗号，单行去掉；
 *  - 'preserve'  保持源码原样。
 */
export type TrailingCommaMode = 'never' | 'multiline' | 'preserve'

export interface FormatOptions {
  /** 行宽上限：超过后格式化器开始断行 */
  printWidth: number
  /** 每层缩进的空格数 */
  indentSize: number
  /** 对象构造的尾随逗号策略（缺省 'never'） */
  trailingComma?: TrailingCommaMode
}

export const defaultFormatOptions: FormatOptions = {
  printWidth: 100,
  indentSize: 2,
  trailingComma: 'never'
}

/** 输入无法被安全格式化时抛出（词法错误、括号不配对等）。 */
export class FormatError extends Error {}
