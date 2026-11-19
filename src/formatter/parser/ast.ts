/**
 * jq AST 节点类型 —— 仅供格式化器内部使用。
 *
 * 文法事实来源：jqlang/jq src/parser.y（参照 gojqparser/parser.go.y 交叉
 * 核对）。span 一律是 tokenizer 全量 token 数组（含注释 token）上的半开
 * 区间 [start, end)：节点内部交错的注释属于节点，最后一个实 token 之后
 * 的注释不属于。行/列信息查 token 表即可，不需要独立的位置类型。
 *
 * 设计原则：打印器按 token 下标顺序发射（绝不重排），因此 AST 只存
 * 打印决策需要的结构信息（子节点、断行判定所需的边界），其余 token
 * 由 span 覆盖、发射时自然带出。
 */

/** 所有节点共享的 span */
export interface Node {
  start: number
  end: number
}

export interface Program extends Node {
  /** module 元数据头（`module {…};`），无则为 null */
  meta: Query | null
  imports: ImportNode[]
  /** 仅注释文件（无任何实 token）时为 null */
  body: Query | null
}

export interface ImportNode extends Node {
  kw: 'import' | 'include'
  /** import 路径的 string token */
  path: number
  /** `import … as <名字>` 的名字 token（含 a::b 链则为首 token） */
  alias: number | null
  /** import/include 的元数据（`{…}`） */
  meta: Query | null
}

// ---------------------------------------------------------------------------
// 查询层：pipe > comma > （as / label / expr）
// ---------------------------------------------------------------------------

export type Query = PipeNode | CommaNode | AsNode | LabelNode | ExprQuery

/** 管道链：段与段之间以 '|' 相连（单段且无 def 时退化为段内查询） */
export interface PipeNode extends Node {
  kind: 'pipe'
  segments: PipeSegment[]
}

/**
 * 管道段。前导 def 挂在（段内逗号列表的）首个 CommaItem 上 ——
 * `a | def f: 1; b` 的右段 head 是含单个 def 条目的逗号节点。
 */
export interface PipeSegment extends Node {
  /** 逗号列表或单个条目 */
  head: Query
}

/** 逗号列表（只在段内出现，'<' 管道） */
export interface CommaNode extends Node {
  kind: 'comma'
  items: CommaItem[]
}

/**
 * 逗号条目：def 前缀 +（as 绑定 | label | 普通表达式）。
 * as 绑定只能是列表的最后一个条目（其 body 吞掉剩余管道）。
 * head 为 null 仅发生在「文件以悬空 def 结尾」的宽容情形
 * （严格 jq 要求 def 后必须跟查询；格式化器对 EOF 处网开一面）。
 */
export interface CommaItem extends Node {
  defs: FuncDefNode[]
  head: AsNode | LabelNode | ExprQuery | null
}

/** `E as $p ?// $q | body` —— head 是 Expr 级，body 是完整查询 */
export interface AsNode extends Node {
  kind: 'as'
  head: Query
  patterns: PatternNode[]
  body: Query
}

/** `label $out | body` */
export interface LabelNode extends Node {
  kind: 'label'
  varTok: number
  body: Query
}

export interface ExprQuery extends Node {
  kind: 'expr'
  expr: Expr
}

// ---------------------------------------------------------------------------
// 表达式层：Pratt 双目运算符链（层级见 parse.ts）
// ---------------------------------------------------------------------------

export type Expr = TermExpr | ChainNode

export interface TermExpr extends Node {
  kind: 'term'
  term: Term
}

/** 同一优先级的扁平运算符链：`a + b - c` */
export interface ChainNode extends Node {
  kind: 'chain'
  first: Expr
  links: ChainLink[]
}

export interface ChainLink {
  /** 运算符 token 下标 */
  op: number
  operand: Expr
}

// ---------------------------------------------------------------------------
// 词项层
// ---------------------------------------------------------------------------

export interface Term extends Node {
  inner: TermInner
  /** 后缀链：.foo / ."foo" / [e] / [a:b] / [] / ? */
  suffixes: Suffix[]
}

export type TermInner =
  | { kind: 'identity' }
  | { kind: 'recurse' }
  /** 初始字段访问 `.foo` / `."foo"`（. 后接 string 不要求邻接） */
  | { kind: 'field'; dotTok: number; name: number }
  /** 函数 / 变量 / 常量名（含 a::b 模块链），可带实参组 */
  | { kind: 'func'; name: number; args: Query[] | null }
  | { kind: 'object'; entries: ObjectEntry[]; trailingSep: number | null }
  | { kind: 'array'; body: Query | null }
  | { kind: 'number'; tok: number }
  /** 一元 '-'/'+'
   * （操作数是 Term —— `-1 + 2` 为 `(-1) + 2`） */
  | { kind: 'unary'; op: number; operand: Term }
  /** `@base64` / `@base64 "x"`（str 为 string token） */
  | { kind: 'format'; tok: number; str: number | null }
  /** 字符串字面量（含插值与裸换行，整体原样保留） */
  | { kind: 'string'; tok: number }
  | { kind: 'if'; clauses: IfClause[]; elseQ: Query | null }
  | { kind: 'try'; body: Expr; catchBody: Expr | null }
  | { kind: 'reduce'; src: Expr; pattern: PatternNode; group: SemiGroup }
  | { kind: 'foreach'; src: Expr; pattern: PatternNode; group: SemiGroup }
  | { kind: 'break'; varTok: number }
  | { kind: 'paren'; body: Query }
  /** `$$$name`（jq builtin.jq 私有技巧） */
  | { kind: 'rawvar'; varTok: number }

/**
 * if 的子句序列：首元素是 `if cond then body`，后续元素是
 * `elif cond then body`。else/end 由外层字段与 span 覆盖。
 */
export interface IfClause {
  cond: Query
  then: Query
}

export type Suffix =
  | ({ kind: 'field'; dotTok: number; name: number } & Node)
  | ({ kind: 'index'; q: Query } & Node)
  | ({ kind: 'slice'; from: Query | null; to: Query | null } & Node)
  | ({ kind: 'iter' } & Node)
  | ({ kind: 'optional' } & Node)

// ---------------------------------------------------------------------------
// 对象构造
// ---------------------------------------------------------------------------

export interface ObjectEntry extends Node {
  key: ObjectKey
  /** 简写条目（`{foo}`、`{$var}`）为 null */
  value: Query | null
}

export type ObjectKey =
  | { kind: 'name'; tok: number }
  | { kind: 'string'; tok: number }
  | { kind: 'query'; q: Query }

// ---------------------------------------------------------------------------
// reduce / foreach 分组与析构模式
// ---------------------------------------------------------------------------

/** `(...; ...)` 分号分隔的组（reduce/foreach 与 def 参数共用形态） */
export interface SemiGroup extends Node {
  parts: Query[]
}

export type PatternNode =
  | ({ kind: 'pvar'; tok: number } & Node)
  | ({ kind: 'parray'; items: PatternNode[] } & Node)
  | ({ kind: 'pobject'; entries: PatternEntry[] } & Node)

export interface PatternEntry extends Node {
  key: ObjectKey
  /** `$var` 简写（`{$a}`）为 null */
  value: PatternNode | null
}

// ---------------------------------------------------------------------------
// def
// ---------------------------------------------------------------------------

export interface FuncDefNode extends Node {
  /**
   * 参数列表：各参数名的 token span（含 a::b 链）。null = 无参 def。
   * 组的开/闭括号由 span 邻接推导（`(` 在首参之前、`)` 在末参之后），
   * 参数之间的 `;` 归组的元素循环发射。
   */
  params: { start: number; end: number }[] | null
  /** def 体（span 覆盖 `def name(args): … ;` 全部 token） */
  body: Query
}
