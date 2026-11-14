# jq Language Support (vscode-jq)

为 [jq](https://jqlang.github.io/jq/) 语言提供的 VS Code 插件：**语法高亮** + **格式化** + **语言服务器**（诊断、补全、悬停、跳转定义）。

语法依据 jq 官方文法（[jqlang/jq `src/parser.y`](https://github.com/jqlang/jq/blob/master/src/parser.y)）实现，覆盖其全部 token 集。

## 功能

### 语法高亮（TextMate grammar）

- 关键字：`def` / `if` / `then` / `elif` / `else` / `end` / `as` / `reduce` / `foreach` / `try` / `catch` / `label` / `break` / `import` / `include` / `module` / `and` / `or`
- 字面量：`true` / `false` / `null`、数字（含 jq 1.8 的前导小数点写法 `.5`）、字符串
- 字符串插值 `"\(expr)"` 中嵌套高亮（支持多层嵌套）；非法转义（如 `"\a"`）标为非法
- 变量 `$foo`、`$__loc__`、`$ENV`
- 格式化函数 `@base64` / `@json` / `@csv` …
- 运算符：全部赋值运算符（`|=`、`//=`、`+=` …）、`?//`、`//`、`..` 等
- 全部 jq 1.8 内建函数（`map`、`select`、`pick`、`tgamma`、`INDEX` …）高亮为 support function
- `def name` 的函数名高亮为 entity.name.function
- `#` 行注释，含 jq 1.8 规范的**反斜杠续行**：行尾有奇数个 `\` 时，下一行也是注释（shebang 技巧所依赖的行为）

### 语言服务器（jq-lsp）

集成 [wader/jq-lsp](https://github.com/wader/jq-lsp) 作为后台语言服务器，提供：

- **诊断**：语法错误、未定义的函数/变量
- **自动补全**：内建函数、`def` 定义的函数、变量
- **悬停文档**：内建函数的定义与文档
- **跳转定义**：函数与 `$变量`
- `import` / `include` 支持，文档符号（`⇧⌘O`）

安装语言服务器（任选其一）：

```bash
brew install jq-lsp                 # Homebrew
go install github.com/wader/jq-lsp@latest   # 从源码（装到 ~/go/bin）
```

> jq-lsp 不提供格式化（其解析器丢弃空白与注释），格式化由本插件内置实现承担，两者互不干扰。
> 若 `jq-lsp` 不在 VS Code 进程的 PATH 上（常见于 `go install` 装到 `~/go/bin`、或 macOS 从 Dock 启动 VS Code 时），请把 `jq.lsp.path` 设为二进制的绝对路径。语言服务器不可用时，格式化仍然可用。

#### 设置

| 设置 | 默认值 | 说明 |
|---|---|---|
| `jq.lsp.enabled` | `true` | 是否启动语言服务器（不影响格式化） |
| `jq.lsp.path` | `jq-lsp` | jq-lsp 的命令名或绝对路径 |

### 格式化

通过 `Format Document`（`⇧⌥F`）使用，纯空白重排，不改变任何 token 内容；无法解析（括号不配对、字符串未闭合等）的文件保持原样。

风格规则：

- 默认 2 空格缩进，行宽超过 `jq.format.printWidth`（默认 80）时断行
- 管道断行采用前置 `|` 风格并缩进一级：

  ```jq
  [.[] | {name, score: (.points // 0)}]
  | sort_by(-.score)
  | .[0:3]
  ```

- `{}` / `[]` / `()` 分组：源码中有换行、包含注释、或超行宽时展开为一行一个元素，否则保持单行
- `def`/`if`/`try`/`reduce`/`foreach` 按子句换行，保留用户在合法断点的换行（最多保留一个空行）
- 一元负号紧贴操作数（`-.score`），对象冒号后有空格（`{a: 1}`），切片冒号无空格（`.[2:5]`）
- 注释保留：独立注释独占一行，行尾注释保持行尾；反斜杠续行的注释整体原样保留（续行内容不重排、不改语义）

#### 设置

| 设置 | 默认值 | 说明 |
|---|---|---|
| `jq.format.printWidth` | `80` | 触发断行的最大行宽 |
| `jq.format.indentSize` | `2` | 每级缩进空格数 |

> 目前仅支持整文档格式化（Format Document），暂不支持 Format Selection。

## 开发

```bash
pnpm install
pnpm compile   # 类型检查（tsc）+ 打包（esbuild → dist/）
pnpm test      # 编译并运行单元测试
```

调试：在 VS Code 中打开本工程，按 `F5` 启动扩展开发宿主（Extension Development Host），打开任意 `.jq` 文件验证。

打包发布：`pnpm add -g @vscode/vsce && vsce package`（运行时依赖已由 esbuild 打进 `dist/`，无需随包分发 node_modules）。

## License

MIT
