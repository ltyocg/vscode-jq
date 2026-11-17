/**
 * 公共 API：选项与错误类型。
 * 独立成叶子模块（不依赖其他 formatter 文件），供入口层与布局层
 * 共同引用，避免循环依赖。
 */

export interface FormatOptions {
  /** 行宽上限：超过后格式化器开始断行 */
  printWidth: number
  /** 每层缩进的空格数 */
  indentSize: number
}

export const defaultFormatOptions: FormatOptions = { printWidth: 100, indentSize: 2 }

/** 输入无法被安全格式化时抛出（词法错误、括号不配对等）。 */
export class FormatError extends Error {}
