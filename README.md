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

| 设置             | 默认值   | 说明                               |
| ---------------- | -------- | ---------------------------------- |
| `jq.lsp.enabled` | `true`   | 是否启动语言服务器（不影响格式化） |
| `jq.lsp.path`    | `jq-lsp` | jq-lsp 的命令名或绝对路径          |

### 格式化

通过 `Format Document`（`⇧⌥F`）使用。格式化保留字符串等 token 的内容，除了空白之外只会按配置增删对象构造的尾随逗号；无法解析（括号不配对、字符串未闭合等）的文件保持原样。

风格规则：

- 默认 2 空格缩进，行宽超过 `jq.format.printWidth`（默认 100）时断行
- 管道断行采用前置 `|` 风格并缩进一级：

  ```jq
  [.[] | {name, score: (.points // 0)}]
  | sort_by(-.score)
  | .[0:3]
  ```

- `{}` / `[]` / `()` 分组：源码中有换行、包含注释、或超行宽时展开为一行一个元素，否则保持单行
- `if`/`try` 的分支内容比关键字深一级缩进；悬挂分组（开括号后接内容）里挂在开括号行上的运算符链（`|`、`//`、`+` …）与开括号竖向对齐
- `def`/`if`/`try`/`reduce`/`foreach` 按子句换行，保留用户在合法断点的换行：`;` 与冒号之后、运算符（含 `and`/`or`）前后、`reduce`/`foreach` 的 `as` 绑定之后等；已折行的位置（含运算符留在行尾的尾随风格）不会被合回一行（连续两个以上的空行压缩到两个）
- 一元负号紧贴操作数（`-.score`），对象冒号后有空格（`{a: 1}`），切片冒号无空格（`.[2:5]`）
- 注释保留：独立注释独占一行，行尾注释保持行尾；反斜杠续行的注释整体原样保留（续行内容不重排、不改语义）

#### 设置

| 设置                      | 默认值  | 说明                                                                                      |
| ------------------------- | ------- | ----------------------------------------------------------------------------------------- |
| `jq.format.printWidth`    | `100`   | 触发断行的最大行宽                                                                        |
| `jq.format.indentSize`    | `2`     | 格式化和智能回车每级缩进的空格列数，不会改写编辑器的 Tab 设置                             |
| `jq.format.trailingComma` | `never` | 对象构造尾随逗号：`never` 去掉；`multiline` 只在展开的非空对象中补齐；`preserve` 保留有无 |

这些设置按当前 jq 文件所属的工作区文件夹读取。格式化保留 LF/CRLF；如果源码混用结构换行，以首个结构换行为准，字符串和注释续行中的换行不参与判断。

> 目前仅支持整文档格式化（Format Document），暂不支持 Format Selection。

### 智能回车

在 jq 文件中按 Enter 时，遇到对象值、子句体、括号内容或运算符的右侧内容，会在当前构造的实际基准列上加一个 `jq.format.indentSize`。同级条目保持对齐，连续输入同一条链不会逐级右移。空括号对仍会展开，光标留在中间。视觉列按编辑器的实际 Tab 宽度计算，插入 Tab 还是空格由 `editor.insertSpaces` 决定。

多光标、非空选区、无法判断缩进、或光标所在行末之前超过 64 Ki 个 UTF-16 码元时，交回 VS Code 默认回车。可通过 jq 的 `editor.autoIndent` 设为 `none` 或 `keep` 停用智能缩进。

## 开发

使用 Node.js 和 pnpm。CI 使用 Node.js 26 和 pnpm 12，可作为本地开发的参考：

```bash
pnpm install --frozen-lockfile
pnpm typecheck       # 检查扩展与构建脚本的类型
pnpm format:check    # 检查仓库代码风格
pnpm test            # 单元测试、golden 与格式化选项矩阵
pnpm compile         # 类型检查 + esbuild 打包到 dist/
pnpm run test:extension  # 在隔离的 VS Code 宿主中测试多根工作区、回车及设置
pnpm run package     # 生成 build/*.vsix 并校验实际归档内容
```

扩展宿主测试默认下载 `engines.vscode` 声明的最低版本；设 `VSCODE_EXECUTABLE_PATH` 可复用本机 VS Code 可执行文件。Linux 无显示环境可用 `xvfb-run -a pnpm run test:extension`。Windows 和 Linux CI 都运行单元测试、宿主测试及 VSIX 归档检查。

手动调试：在 VS Code 中打开本工程，按 `F5` 启动扩展开发宿主，打开任意 `.jq` 文件验证。

## License

MIT
