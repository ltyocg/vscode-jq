# 项目约定

## 私有成员写法

类的私有成员统一使用 JS 原生井号语法（`#name`），不使用 TypeScript 的 `private` 关键字：

- 字段：`#count = 0`（需要只读时写 `readonly #count`）。
- 方法与 getter：`#fmtTok()`、`get #is()`。
- 构造函数参数属性不支持 `#`：改成普通参数，在类顶部声明 `readonly #xxx` 字段并在构造函数里显式赋值。

新增代码时不得引入 `private` 关键字。
