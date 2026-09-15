# dsh-quick-shell 技术手册

本文档记录 `dsh-quick-shell` 插件的实现决策、架构分层和关键技术细节。README 回答"做什么、怎么用"，本文档回答"为什么这么做、内部怎么跑"。

## 目录

- [架构总览](#架构总览)
- [DSH 命令系统集成](#dsh-命令系统集成)
- [Parser 设计](#parser-设计)
- [Runner 注册表](#runner-注册表)
- [子进程执行模型](#子进程执行模型)
- [输出解码：UTF-8 优先与 GBK 回退](#输出解码utf-8-优先与-gbk-回退)
- [Client 装饰层](#client-装饰层)
- [测试策略](#测试策略)
- [Profile 安装与模块解析](#profile-安装与模块解析)
- [文件职责矩阵](#文件职责矩阵)

---

## 架构总览

插件分为 Host 和 Client 两侧，运行在不同的 Cordis context 中，不能混用：

```
┌─────────────────────────── Host（Node 进程）───────────────────────────┐
│                                                                         │
│  src/index.js          插件入口，导出 name / inject / apply            │
│       │                                                                 │
│       ▼                                                                 │
│  command-runtime.js    遍历 RUNNERS，向 ctx.commands.register 逐个注册  │
│       │                   handler 职责：解析 → 委派 adapter             │
│       ▼                                                                 │
│  dsh-adapter.js        spawnAndCollect：启动子进程、收集输出、超时/取消  │
│       │                   decodeOutput：UTF-8 优先、GBK 回退            │
│       ▼                                                                 │
│  node:child_process    spawn(bash/cmd.exe/pwsh, ...)                   │
│                                                                         │
│  parser.js             纯函数，解析 /shell ls -la → { kind, line }     │
│  runners.js            数据注册表，build(command) → { file, args }     │
│                                                                         │
└─────────────────────────────────────────────────────────────────────────┘

┌─────────────────────── Client（浏览器）────────────────────────────────┐
│                                                                         │
│  client/client.js      window.__ModuleLoader__.load 工厂入口           │
│       │                                                                 │
│       ├─ commandUi.decorate()  为 /shell /cmd /pwsh 各注册一个 popupSelect │
│       │                  onSelect → 回填输入框前缀 + 恢复焦点           │
│       │                                                                 │
│       └─ slots.inject('conversation.chat.commandview')                  │
│                          为每个 runner 注册 keyed 命令卡片，标题显示     │
│                          「命令名 + 输入原文」（cmd "dir"）              │
│                                                                         │
└─────────────────────────────────────────────────────────────────────────┘
```

### 数据流（一次命令执行）

```
用户输入 /shell ls -la 并发送
  │
  ▼
DSH 命令解析器 parseCommand(line)            ← packages/interaction/commands/src/index.ts:122
  │  正则 /^\/([a-z][a-z0-9_-]*)(?=$|[\t\n\r ])/ 匹配 name=shell
  │  rawInput = " ls -la"
  ▼
ctx.commands.execute(agent, line, [], signal) ← 同文件 :356
  │  写 command/run 事件到会话日志
  │  组装 CommandInvocation { commandId, agent, rawInput, signal, attachments }
  ▼
command-runtime.js handler(invocation)
  │  parseInvocation('shell', invocation)
  │    → parseSlash('/shell ls -la')
  │    → { matched: true, command: { kind: 'shell', line: 'ls -la' } }
  ▼
adapter.runCommand('shell', 'ls -la', invocation)
  │  RUNNERS.shell.build('ls -la') → { file: 'bash', args: ['-c', 'ls -la'] }
  │  cwd = agent.session.header.cwd
  │  spawnAndCollect(spawn, recipe, { cwd, signal, timeoutMs, maxBytes, decode })
  ▼
spawn('bash', ['-c', 'ls -la'], { cwd, stdio: ['ignore','pipe','pipe'] })
  │  stdout/stderr → Buffer chunks（受 maxBytes 上限）
  │  exit → finish(code)
  ▼
{ kind: 'success', text: '[exit code 0]\nfile1\nfile2' }
  │
  ▼
ctx.commands.execute 写 command/done 事件
  │
  ▼
Client 命令卡片（标题 name + args）展示 text
```

---

## DSH 命令系统集成

### 命令名解析的硬约束

DSH 的命令解析器（`packages/interaction/commands/src/index.ts:122`）用正则匹配命令名：

```typescript
const match = /^\/([a-z][a-z0-9_-]*)(?=$|[\t\n\r ])/u.exec(line)
```

命令名 `[a-z][a-z0-9_-]*` 后必须是空白或行尾（`(?=$|[\t\n\r ])`）。这意味着：

| 输入 | 是否匹配为命令 | 原因 |
|---|---|---|
| `/shell ls -la` | ✅ 匹配，name=`shell` | 空格分隔 |
| `/shell:ls -la` | ❌ 不匹配 | 冒号不是空白，正则的 lookahead 失败 |
| `/Shell ls` | ❌ 不匹配 | 大写不在 `[a-z]` 范围 |

`/shell:ls` 不匹配时，`parseCommand` 返回 `undefined`，`execute` 返回 `undefined`，DSH 把整行当作普通用户消息发给模型。这就是用户最初看到"前端没有走插件"的根本原因之一。

本插件接受这个约束，要求空格分隔语法。Parser 额外容忍单个前导冒号（`/shell :ls`）作为善意兼容，但不尝试拦截 `/shell:ls`——那需要绕过 DSH 命令系统在提交前改写输入，超出插件职责。

### CommandInvocation 结构

命令解析成功后，`execute` 组装 `CommandInvocation`（同文件 :40-57）传给 handler：

```typescript
interface CommandInvocation {
  readonly commandId: CommandId    // command/run 事件的配对 id
  readonly agent: Agent            // 接收命令的 agent
  readonly rawInput: string        // 命令名后的完整文本（含前导空格）
  readonly attachments: readonly (ImageBlock | FileBlock)[]  // 附件
  readonly signal: AbortSignal     // UI 请求的取消信号
}
```

本插件用到的字段：
- `rawInput`——传给 parser 解析出命令行
- `agent.session.header.cwd`——子进程的工作目录
- `signal`——传给 spawn 的取消监听

### command/done 事件

`execute` 在 handler 返回后写 `command/done` 事件：

```typescript
this.appendLifecycle(agent.session, 'command/done', {
  commandId, kind: result.kind,
  ...result.text === undefined ? {} : { text: result.text },
})
```

`result.text` 就是 Web UI 显示的命令输出。本插件的 `spawnAndCollect` 返回的 `text` 包含横幅标记 + stdout + stderr，直接通过这个通道回到前端，无需额外的客户端抓取逻辑。

---

## Parser 设计

`src/parser.js` 是零依赖纯函数，输入字符串，输出结构化结果。

### 返回值类型

```javascript
// 匹配成功
{ matched: true, command: { kind: 'shell', line: 'ls -la', rawInput: '/shell ls -la' } }

// 匹配失败但有明确错误（用户意图是命令但格式不对）
{ matched: false, error: { code: 'MISSING_COMMAND', message: '/shell requires a command' } }

// 不是命令（普通文本，不报错）
{ matched: false }
```

`matched: false` 且无 `error` 表示"这不是命令，放行给模型"。`matched: false` 且有 `error` 表示"这是命令但格式错误，应返回错误"。区分的理由：URL（`https://...`）和行内引用（`请执行 /shell ls`）不应被当成命令错误，应静默放行。

### 正则与清理

```javascript
const match = /^\/([a-z][a-z0-9_-]*)(?:[\t\n\r ]([\s\S]*))?$/.exec(trimmed)
```

- 命令名必须小写字母开头，后续允许小写、数字、下划线、连字符——与 DSH 的 `COMMAND_NAME = /^[a-z][a-z0-9_-]*$/u` 一致
- 命令名后捕获空白和剩余文本（`[\s\S]*` 含换行，保留多行命令）
- 前导冒号容忍：`remainder.replace(/^\s*:?\s*/, '')` 去掉一个可选的 `:`

### 非命令排除

```javascript
if (!trimmed.startsWith('/') || trimmed.startsWith('//') || trimmed.startsWith('\\/'))
  return ordinary();
if (trimmed.startsWith('```') || (trimmed.startsWith('`') && trimmed.endsWith('`')))
  return ordinary();
```

- `//shell`——行注释或协议相对 URL，排除
- `\/shell`——转义斜杠，排除
- `` `/shell ls` `` 和 ` ```/shell ls``` `——行内/块级代码，排除

### RUNNERS 集合同步

`parser.js` 自己维护一份 `RUNNERS = new Set(['shell', 'cmd', 'pwsh'])`，不 import `runners.js`。理由：parser 零依赖更易测。代价是两处需要手动同步——`test/runners.test.js` 有专门测试断言两者一致：

```javascript
test('parser RUNNERS set mirrors the registry keys', () => {
  assert.deepEqual([...RUNNER_NAMES].sort(), Object.keys(RUNNERS).sort());
});
```

---

## Runner 注册表

`src/runners.js` 是数据注册表。每个 runner 是一个对象：

```javascript
{
  name: 'shell',                              // 命令名（slash command name）
  description: 'Run a command in bash',       // DSH 命令描述
  build: (command) => ({ file, args }),       // 生成 spawn 配方
  platforms?: ['win32'],                      // 可选平台限制
}
```

### 为什么 build() 是数据不是行为

`build()` 只返回 `{ file, args }`，不包含任何执行逻辑。收集、超时、取消、解码全由 `dsh-adapter.js` 的 `spawnAndCollect` 统一负责。这样：

- 加一个新 runner 只需在 `RUNNERS` 加一行数据
- 所有 runner 共享相同的超时/取消/截断/解码行为
- runner 可以被纯函数测试（非 Windows 上 `build('ls')` → `{ file: 'bash', args: ['-c', 'ls'] }`）

### 三个 runner 的 spawn 配方

| Runner | file | args | 说明 |
|---|---|---|---|
| shell | `bash` | `['-c', command]` | 跨平台，需 bash 在 PATH |
| cmd | `cmd.exe` | `['/d', '/s', '/c', command]` | `/d` 禁用 AutoRun，`/s` 让 `/c` 正确处理引号 |
| pwsh | 解析后的 PowerShell 路径 | `['-NoProfile', '-Command', PWSH_ENCODING_PREAMBLE + command]` | `-NoProfile` 跳过用户 profile 加载；可执行文件按顺序解析；命令前固定 UTF-8 输出 |

### PowerShell 可执行文件解析

`buildPwsh` 调用 `resolvePwsh(env, platform)`（`runners.js`），在 Windows 上按顺序返回第一个存在的候选，全部不存在时回退裸 `pwsh`：

| 顺序 | 候选 | 说明 |
|---|---|---|
| 1 | `%ProgramFiles%\PowerShell\7\pwsh.exe` | PowerShell 7 常规安装 |
| 2 | PATH 每个目录下的 `pwsh.exe` | 覆盖 Microsoft Store 应用执行别名 |
| 3 | `%SystemRoot%\System32\WindowsPowerShell\v1.0\powershell.exe` | Windows PowerShell 5.1 兜底 |

非 Windows 平台直接返回 `pwsh`，交给 spawn 走 PATH。存在性判断用 `lstatSync` 而非 `statSync`：Store 别名是重解析点，`stat` 会命中目标 ACL 而失败，`lstat` 能看到别名本身。这与 `packages/shell/pwsh-local/src/resolve.ts` 的语义一致，`env` 与 `platform` 参数化让解析成为输入的纯函数，测试不依赖宿主文件系统。

### spawn 选项

`spawnAndCollect` 固定以下 spawn options（`dsh-adapter.js:89-95`）：

```javascript
{
  cwd: agent.session.header.cwd,   // 会话工作目录
  env: process.env,                // 继承 harness 进程环境
  stdio: ['ignore', 'pipe', 'pipe'], // 不读 stdin，捕获 stdout+stderr
  windowsHide: true,               // Windows 上不弹窗
}
```

---

## 子进程执行模型

`spawnAndCollect`（`dsh-adapter.js:79-165`）是插件的核心。它封装了子进程的全部生命周期管理。

### 状态机

```
spawn 成功
  │
  ├─ stdout 'data' → append 到 stdoutChunks（受 maxBytes 限制）
  ├─ stderr 'data' → append 到 stderrChunks
  │
  ├─ timer 到期 → timedOut=true; child.kill('SIGKILL')
  ├─ signal abort → aborted=true; child.kill('SIGKILL')
  │
  └─ child 'close'(code) → finish(code)
     或
     child 'error'(err) → finish(undefined, err)
         │
         ▼
      finish(): settled=true; clearTimeout; removeEventListener
         │  decode stdout/stderr
         │  组装 banners + sections → text
         │  ok = code===0 && !spawnError && !aborted && !timedOut
         ▼
      resolve({ kind: ok ? 'success' : 'error', text })
```

### 四个保护机制

**1. 超时（`timeoutMs`，默认 30s）**

```javascript
const timer = timeoutMs > 0
  ? setTimeout(() => { timedOut = true; child.kill('SIGKILL'); }, timeoutMs)
  : null;
```

到期后 `SIGKILL` 强杀，`timedOut` 标记写入横幅。`timeoutMs: 0` 禁用超时。

**2. 取消（`AbortSignal`）**

```javascript
const onAbort = () => { aborted = true; child.kill('SIGKILL'); };
if (signal) signal.addEventListener('abort', onAbort, { once: true });
```

UI 请求取消时（用户关页面、切换会话等），DSH 传入的 `signal` 触发，子进程被杀。`finish` 中 `removeEventListener` 清理。

如果 `signal` 在进入 `spawnAndCollect` 时已 aborted，直接返回不 spawn：

```javascript
if (signal?.aborted) {
  resolve({ kind: 'error', text: '[aborted by caller]' });
  return;
}
```

**3. 输出上限（`maxBytes`，默认 1 MiB）**

```javascript
const append = (data, sink) => {
  const remaining = maxBytes - totalBytes;
  if (remaining <= 0) { truncated = true; return; }
  const slice = data.length > remaining ? data.subarray(0, remaining) : data;
  sink.push(slice);
  totalBytes += slice.length;
  if (data.length > slice.length) truncated = true;
};
```

stdout 和 stderr 共享同一个 `totalBytes` 计数器。超限后丢弃后续数据但标记 `truncated`，不杀进程——让进程正常退出，只是输出被截断。

**4. spawn 失败（ENOENT 等）**

spawn 本身可能抛异常（比如 `bash` 不在 PATH），用 try/catch 包住：

```javascript
try {
  child = spawnFn(recipe.file, recipe.args, { ... });
} catch (spawnError) {
  resolve({ kind: 'error', text: `Failed to spawn ${recipe.file}: ${message}` });
  return;
}
```

异步的 spawn 错误（`child.on('error')`）在 `finish` 中处理，`ENOENT` 有专门的友好消息：`[spawn error: bash not found on PATH]`。

### settled 防重入

`finish` 用 `settled` 标志防止重复结算。`timer` 和 `onAbort` 可能在 `close` 事件后触发，`settled` 保证只 resolve 一次：

```javascript
const finish = (code, spawnError) => {
  if (settled) return;
  settled = true;
  // ...
};
```

### 输出文本格式

`text` 由横幅 + 输出段拼接：

```
[exit code 0]
<stdout 内容>

--- stderr ---
<stderr 内容>
```

异常情况追加横幅：

```
[aborted by caller]
[timed out after 30000ms]
[output truncated at 1048576 bytes]
[exit code null]
[spawn error: bash not found on PATH]
```

横幅在前，输出在后，`stderr` 有独立分段标记。用户始终能看到发生了什么。

### 成功判定

```javascript
const ok = code === 0 && !spawnError && !aborted && !timedOut;
```

四个条件全满足才是 `success`。非零退出码是 `error` 但仍返回完整输出——用户需要看到错误信息。

---

## 输出解码：UTF-8 优先与 GBK 回退

### 问题

Windows cmd.exe 内置命令（`dir`、`echo` 等）的输出编码取决于控制台代码页。当 stdout 是 pipe（不是 console）时，`chcp 65001` 不生效——cmd.exe 仍用系统 OEM 代码页（中文 Windows 是 CP936/GBK）。用 `Buffer.toString('utf8')` 解码 GBK 字节会得到 U+FFFD 替换字符（乱码）。

bash（git bash）默认输出 UTF-8。pwsh 不同：它的输出编码取决于控制台/OEM 代码页（中文 Windows 上是 CP936），而且部分 GBK 字节对本身就是合法 UTF-8（例如 `一` 的 GBK 字节 `D2BB` 解码为西里尔字符 `һ`，不含 U+FFFD），阶段 1 会静默返回乱码而不触发回退。因此 pwsh 配方前置 UTF-8 固定语句，见[为什么 pwsh 配方要固定 UTF-8](#为什么-pwsh-配方要固定-utf-8)。

### 解法：两阶段解码

`decodeOutput`（`dsh-adapter.js:21-32`）：

```javascript
function decodeOutput(buf, fallbackEncoding) {
  const utf8 = buf.toString('utf8');
  if (!utf8.includes('\uFFFD')) return utf8;        // 阶段 1：UTF-8 有效
  if (fallbackEncoding) {
    try {
      return new TextDecoder(fallbackEncoding).decode(buf);  // 阶段 2：回退
    } catch {
      // 不支持的编码标签 → 返回 UTF-8（含替换字符）
    }
  }
  return utf8;
}
```

**阶段 1**：先按 UTF-8 解码。如果结果不含 U+FFFD，说明原始字节是合法 UTF-8，直接返回。这对 bash/pwsh 以及任何 UTF-8 输出的工具都成立。

**阶段 2**：如果含 U+FFFD（有无效 UTF-8 字节），用 `fallbackEncoding` 通过 `TextDecoder` 重新解码。

为什么用 U+FFFD 检测而不是直接用 `Buffer.toString('utf8')` + 验证：Node 的 `toString('utf8')` 对无效字节用 U+FFFD 替换且不报错。检查 U+FFFD 是最可靠的"是否需要回退"信号。

### 自动检测回退编码

`detectFallbackEncoding`（`dsh-adapter.js:40-61`）：

```javascript
function detectFallbackEncoding() {
  if (process.platform !== 'win32') return undefined;
  const locale = Intl.DateTimeFormat().resolvedOptions().locale.toLowerCase();
  if (locale.startsWith('zh')) return 'gbk';
  if (locale.startsWith('ja')) return 'shift_jis';
  if (locale.startsWith('ko')) return 'euc-kr';
  return undefined;
}
```

用 `Intl.DateTimeFormat().resolvedOptions().locale` 检测系统 locale。不用 `process.env.LANG`——harness 可能把它设成 `zh_CN.UTF-8`，不代表 OS 的 OEM 代码页。

覆盖范围：
- 中文 Windows（CP936/GBK）→ `gbk`
- 日文 Windows（CP932）→ `shift_jis`
- 韩文 Windows（CP949）→ `euc-kr`
- 繁体中文（CP950）→ 需手动传 `fallbackEncoding: 'big5'`（`Intl` 的 `zh-` 前缀无法区分简繁，默认走 `gbk`）
- 西文 Windows（CP437/CP1252）→ 不回退（ASCII 兼容，UTF-8 解码 ASCII 部分正确）

### 可覆盖性

`createDshAdapter` 接受 `options.fallbackEncoding`：

```javascript
const adapter = createDshAdapter(ctx, { fallbackEncoding: 'big5' });
```

测试中传 `fallbackEncoding: 'gbk'` 确保跨平台一致。

### 为什么不在 cmd 配方里加 chcp

实测 `chcp 65001 >nul 2>&1 && dir` 对 pipe 输出无效——`chcp` 改的是 console 代码页，pipe 不经过 console。而且 `chcp` 会产生额外输出（即使重定向也可能残留）。在 adapter 层做解码回退是唯一可靠的方案。

### 为什么 pwsh 配方要固定 UTF-8

pwsh 与 cmd 不同：它的输出编码可以在命令内部用 `[Console]::OutputEncoding` 重设，所以 `buildPwsh` 在命令前固定 UTF-8，而不是依赖 adapter 回退：

```javascript
export const PWSH_ENCODING_PREAMBLE =
  '[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false); $OutputEncoding = [System.Text.UTF8Encoding]::new($false); ';
```

`$false` 表示不写 BOM。语句放在第 1 行、用 `; ` 分隔，PowerShell 的错误行号仍然准确。

为什么必须固定而不能只靠回退：回退只在 UTF-8 解码产生 U+FFFD 时触发，但 GBK 双字节对可能是合法 UTF-8。实测中文 Windows（CP936）上 `pwsh -NoProfile -Command "Write-Output '…'"` 的输出：

| 文本 | GBK 字节 | UTF-8 解码结果 | 含 U+FFFD | 回退是否触发 |
|---|---|---|---|---|
| `一` | `D2BB` | `һ` | 否 | 否 → 乱码 |
| `目录` | `C4BFC2BC` | `Ŀ¼` | 否 | 否 → 乱码 |
| `中文测试` | `D6D0CEC4B2E2CAD4` | 含替换字符 | 是 | 是 → 正确 |

前置 UTF-8 固定后所有样本都按 UTF-8 输出，阶段 1 直接命中。代价与 `pwsh-local` 相同：`param(...)`、`#requires`、`using` 必须位于脚本最顶部，命令首行是这三者时会被前置语句拦住。

---

## Client 装饰层

### 两个入口文件

| 文件 | 用途 |
|---|---|
| `client/client.js` | 浏览器 ModuleLoader 工厂入口，被 Web profile 构建打包 |
| `client/index.js` | 可测试的等价实现，测试直接 import |

两者逻辑相同，`client.js` 用 `window.__ModuleLoader__.load({ id, factory })` 包装，`index.js` 导出 `apply` 和 `inject`。

### 装饰结构

每个 runner 注册一个 `commandUi.decorate()`：

```javascript
{
  name: 'shell',           // / 菜单中的命令名
  available: () => true,
  ui: {
    kind: 'popupSelect',
    async options() {
      return [{ id: '', label: '<command>', detail: 'Run a command in bash' }];
    },
    onSelect(option, session) { return fillComposer(ctx, 'shell', option, session); }
  }
}
```

### 候选设计：单占位符

与 `dsh-quick-invoke` 不同，shell 命令的参数是自由文本（`ls -la`、`Get-Process | Select-Object -First 3`），无法预生成候选列表。因此 `options()` 返回单个占位符 `{ id: '', label: '<command>' }`：

- 用户输入 `/shell` → 菜单出现 `/shell` 选项
- 选择后回填 `/shell `（带尾空格），焦点回到输入框
- 用户继续输入命令文本，手动发送

这保持了"候选选择只回填不执行"的安全边界——与参考插件一致。

### 输入框回填与焦点恢复

`fillComposer`（`client/client.js` 和 `client/index.js`）：

```javascript
const fillComposer = (ctx, runner, option, session) => {
  const actx = ctx.get('sessions').scope(session.sessionId);
  const conversation = actx?.get?.('conversation');
  const input = conversation?.input?.for?.(actx);
  const state = input?.state?.getSnapshot?.();
  // 定位草稿中的 /<runner> token 起始位置
  const token = `/${runner}`;
  const tokenStart = state.draft.lastIndexOf(token);
  // 发射插入事件，替换 token 到草稿末尾
  actx.emit('slash/input-insert-text', {
    text: `${token} ${option.id} `,   // option.id 为空 → "/shell "
    span: { start: tokenStart, end: state.draft.length, draftRev: state.draftRev }
  });
  focusComposerAfterSelection();
};
```

`focusComposerAfterSelection` 在 microtask 中把焦点还给 `[data-composer-card] textarea`——DSH 旧版 Web 不绑定 composer-focus hook，选完后会失焦。这只恢复输入能力，不自动发送。

### 命令结果卡片

DSH 的通用命令卡片只把 `command/run` 的 `name` 显示为标题，输入原文（`args`）既不显示也不丢失——它已经在 `CommandNode` 里。本插件通过 `ctx.slots.inject('conversation.chat.commandview', …)` 为三个 runner 各注册一个 keyed 渲染器，把标题改成 `${name}${args}`：

```javascript
const COMMAND_SLOT = 'conversation.chat.commandview';
slots.inject(COMMAND_SLOT, () => slots.register(
  { name: COMMAND_SLOT, key: 'cmd', locale: 'chat' },
  createCommandCard(require('react'), require('@deepseek-ai/dsh-client-ui-primitives'))
));
```

- **数据来源**：`command/run` 的 `args` 是 `parseCommand` 的 verbatim `rawInput`（含分隔空格），`/cmd "dir"` → `name='cmd'`、`args=' "dir"'`，拼接得到 `cmd "dir"`。Host、会话日志、`CommandResult` 都不需要改动。
- **keyed 替换**：`conversation.chat.commandview` 由 ui-chat 的 `command` 节点条目声明，按命令名分发；未被占用的 key 走通用卡片。本插件只占 `cmd`/`shell`/`pwsh` 三个 key。
- **只读扩展点**：`ctx.commandUi` 是 `/` 候选项 source，与结果卡片无关；插件不改核心组件，也不复用 ui-chat 的内部组件。
- **复用而非复制文案**：注册时声明 `locale: 'chat'`，渲染器为组件注入 ui-chat 的 `t`，状态文案直接用 `command.running` / `command.done` / `command.failed` / `command.title`，随语言切换更新。
- **视觉**：复用 `ui-primitives` 的 `DisclosureRow`、`IconApiOutline14`、`StateDot`；summary 与展开体的样式由插件注入一次 `<style id="dsh-quick-shell-command-card">`，token 与 ui-chat 的 `GenericCommandCard` 一致。
- **模块来源**：`react` 与 `@deepseek-ai/dsh-client-ui-primitives` 都在 shell 的 `PLATFORM_MODULES` 基线里，动态 bundle 通过 factory 的 `require` 取得，无需 `dsh.client.external` 声明。`require` 放在 `slots.inject` 回调内，slot 未声明时不触达模块表。
- **测试**：`client/index.js` 把 React 与 primitives 作为 `apply(ctx, deps)` 参数注入，`test/client.test.js` 用最小 React 桩验证标题、summary、展开与注册；`entry.test.js` 的 VM 用例在无模块表的 realm 里只验证 slot 等待与装饰注册。

---

## 测试策略

### 52 个测试，6 个文件

| 文件 | 测试数 | 覆盖 |
|---|---|---|
| `parser.test.js` | 9 | 正则匹配、冒号容忍、非命令排除、错误码、RUNNERS 同步 |
| `runners.test.js` | 13 | 三个 runner 的 build 配方、平台限制、PowerShell 可执行文件解析、UTF-8 输出固定、RUNNERS 集同步 |
| `command-runtime.test.js` | 5 | 命令注册、handler 委派、parse 错误短路、冒号容忍、disposer |
| `dsh-adapter.test.js` | 12 | spawn 收集、退出码、超时、取消、截断、ENOENT、cwd、GBK 解码、UTF-8 不误判 |
| `entry.test.js` | 6 | Host/Client 入口契约、cordis.patch.yml、package.json、浏览器 VM 加载 |
| `client.test.js` | 7 | 命令卡片标题拼接、summary、展开、`slots.inject` 注册、`inject` 列表 |

### spawn 桩注入

`dsh-adapter.test.js` 不触达真实进程表。通过 `options.spawn` 注入用 `EventEmitter` 构造的假 child：

```javascript
function fakeChild() {
  const child = new EventEmitter();
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.kill = () => { queueMicrotask(() => child.emit('close', null)); };
  return child;
}

function fakeSpawn(drive) {
  const calls = [];
  const fn = (file, args, options) => {
    const child = fakeChild();
    calls.push({ file, args, options });
    if (drive) queueMicrotask(() => drive(child));  // 测试控制事件序列
    return child;
  };
  fn.calls = calls;
  return fn;
}
```

测试用 `drive` 回调精确控制事件序列：先 `stdout.emit('data', ...)`，再 `emit('close', code)`。这让超时、取消、截断等竞态场景可以确定性测试。

### GBK 解码测试

```javascript
test('falls back to GBK when output is not valid UTF-8', async () => {
  const gbkBuf = Buffer.from([0xc7, 0xfd, 0xb6, 0xaf, 0xc6, 0xf7]); // "驱动器" in GBK
  const spawn = fakeSpawn((child) => {
    child.stdout.emit('data', gbkBuf);
    child.emit('close', 0);
  });
  const adapter = createDshAdapter({}, { spawn, fallbackEncoding: 'gbk' });
  const result = await adapter.runCommand('shell', 'echo', {});
  assert.ok(result.text.includes('驱动器'));
});

test('does not corrupt valid UTF-8 output even with a fallback configured', async () => {
  const utf8Buf = Buffer.from('hello 世界', 'utf8');
  // ... 同样结构，断言 'hello 世界' 完整保留
});
```

第二个测试确保 UTF-8 输出不会因为有 fallback 配置而被错误地用 GBK 重新解码。

### 跨平台测试

所有测试在任意平台通过——`/cmd` 的平台限制由 adapter 在运行时检查（`runner.platforms.includes(process.platform)`），测试用 `/shell` 驱动 spawn 桩，不依赖 Windows。

### 浏览器 VM 测试

`entry.test.js` 用 `vm.runInNewContext` 加载 `client/client.js`：

```javascript
vm.runInNewContext(source, { window: { __ModuleLoader__: { load(value) { plugin = value.factory(() => {}); } } } });
```

在 Node 中模拟浏览器环境，验证装饰注册、候选生成、输入框回填。跨 realm 对象比较用原始值（`request.text`）而非 `deepStrictEqual` 整对象——VM 领域的 `Object.prototype` 不同会导致 `deepStrictEqual` 误判。

---

## Profile 安装与模块解析

### 双锚模块解析

DSH profile 的模块解析是双锚的（`packages/boot/app-boot/src/profile.ts:15-22`）：

1. 先从 profile 目录的 `node_modules` 解析（pnpm hoisted 管理）
2. 再从 DSH 安装的 `profiles/node_modules` 共享回退解析

这保证 out-of-tree 插件的 peer deps（`@deepseek-ai/cordis`、`@deepseek-ai/dsh-commands` 等）能从共享安装解析到——插件自己不安装这些包，共享安装提供单一实例。

### bundles 列表

profile `package.json` 的 `dsh.profile.bundles` 列表决定加载哪些包。只有列在 `bundles` 中的包，其 `cordis.patch.yml`（通过 `dsh.bundle.patch` 声明）才会被组合进 profile 的 entry 树。

**这是最常见的安装遗漏**：包在 `dependencies` 里、`node_modules` 里有链接，但没加进 `bundles`——DSH 不会加载它，命令不会注册。

### link 协议与 junction

pnpm 的 `link:` 协议创建 junction（Windows）或 symlink（POSIX）。`link:` 后的路径是相对于 profile 目录解析的：

```json
// ❌ 相对路径——从 profile 目录解析，找不到 scratch-plugin
"dsh-quick-shell": "link:scratch-plugin\\dsh-quick-shell"

// ✅ 绝对路径——直接指向源码
"dsh-quick-shell": "link:D:\\work\\deepseek-harness\\scratch-plugin\\dsh-quick-shell"
```

pnpm 创建 junction 后如果路径变了，`pnpm install` 不会自动重建（包名没变，它认为已经满足）。需要手动删除旧 junction 再 `mklink /J` 重建。

### 正确的 profile package.json

```json
{
  "name": "dsh-profile-web",
  "private": true,
  "dependencies": {
    "dsh-quick-shell": "link:D:\\work\\deepseek-harness\\scratch-plugin\\dsh-quick-shell"
  },
  "dsh": {
    "profile": {
      "bundles": [
        "@deepseek-ai/dsh-base",
        "@deepseek-ai/dsh-web-app",
        "dsh-quick-shell"
      ],
      "patchReload": "live"
    }
  }
}
```

两个关键点：`dependencies` 用绝对路径 `link:`，`bundles` 包含插件名。

---

## 文件职责矩阵

| 文件 | 行数 | 职责 | 依赖 |
|---|---|---|---|
| `src/index.js` | 18 | Host 插件入口，导出 `name`/`inject`/`apply` | `command-runtime`、`dsh-adapter` |
| `src/command-runtime.js` | 55 | 遍历 `RUNNERS` 注册命令，handler 解析+委派 | `parser`、`runners` |
| `src/dsh-adapter.js` | 201 | `spawnAndCollect`（spawn/收集/超时/取消/截断/解码）+ `createDshAdapter` | `node:child_process`、`runners` |
| `src/parser.js` | 52 | 纯函数 slash parser，零依赖 | 无 |
| `src/runners.js` | 157 | runner 数据注册表，`build()` 返回 spawn 配方，PowerShell 可执行文件解析与 UTF-8 输出固定 | `node:fs`、`node:path` |
| `client/client.js` | 183 | 浏览器 ModuleLoader 工厂入口：`commandUi.decorate` + `slots.inject` 命令卡片 | `react`、`@deepseek-ai/dsh-client-ui-primitives`（模块表基线） |
| `client/index.js` | 190 | 可测试的 Client 实现，`apply(ctx, deps)` 注入 React/primitives | 无 |
| `cordis.patch.yml` | 5 | Host bundle patch，`insert: id: dsh-quick-shell` | 无 |
| `package.json` | 37 | 包元数据、peerDeps、`dsh.bundle.patch`、`dsh.client` | 无 |
| `test/parser.test.js` | 9 tests | parser 正则、错误边界、非命令排除 | `src/parser` |
| `test/runners.test.js` | 13 tests | spawn 配方、平台限制、PowerShell 可执行文件解析、UTF-8 输出固定、RUNNERS 同步 | `src/runners`、`src/parser` |
| `test/command-runtime.test.js` | 5 tests | 命令注册、handler 委派、disposer | `src/command-runtime` |
| `test/dsh-adapter.test.js` | 12 tests | spawn 桩、收集、超时、取消、截断、ENOENT、GBK | `src/dsh-adapter` |
| `test/entry.test.js` | 6 tests | 入口契约、package.json、浏览器 VM 加载 | `src/index`、`client/index`、`client/client.js` |
| `test/client.test.js` | 7 tests | 命令卡片标题、summary、展开、slot 注册、`inject` 列表 | `client/index` |

### 分层依赖

```
index.js
  ├── command-runtime.js ──┬── parser.js（零依赖）
  │                         └── runners.js（零依赖）
  └── dsh-adapter.js ───────┤
                             └── runners.js
                             └── node:child_process
```

`parser.js` 是零依赖叶子模块；`runners.js` 只依赖 `node:fs` 和 `node:path`，同样可独立测试。`dsh-adapter.js` 依赖 `node:child_process`，通过 `options.spawn` 注入实现可测试性。

---

## 扩展指南

### 加一个新 runner

1. 在 `src/runners.js` 的 `RUNNERS` 加一条：
   ```javascript
   python: { name: 'python', description: 'Run a Python script', build: (cmd) => ({ file: 'python', args: ['-c', cmd] }) }
   ```
2. 在 `src/parser.js` 的 `RUNNERS` Set 加 `'python'`
3. 在 `client/client.js` 和 `client/index.js` 的 `RUNNERS` 数组加 `{ id: 'python', detail: '...' }`
4. 运行 `npm test`——`runners.test.js` 的同步测试会自动验证

不需要改 `command-runtime.js`、`dsh-adapter.js`——它们从 `RUNNERS` 动态生成命令注册。

### 调整执行参数

```javascript
const adapter = createDshAdapter(ctx, {
  timeoutMs: 60_000,        // 60s 超时
  maxBytes: 4 * 1024 * 1024, // 4MB 输出上限
  fallbackEncoding: 'big5',  // 繁体中文
});
```

在 `src/index.js` 的 `apply` 中传给 `createDshAdapter`。或在测试中注入覆盖。
