# dsh-quick-shell
`dsh-quick-shell` 是一个面向 DSH Web 的独立 Cordis 插件，为 bash、cmd.exe、PowerShell 提供统一的 `/` 快捷入口和子进程命令执行能力。

本插件不修改 DSH 核心，不绕过 DSH 的命令系统。命令经 DSH `ctx.commands` 注册、解析、记录 `command/run` 与 `command/done`，结果以命令结果形式回到 Web 前端。

## 功能概览

| 命令 | 作用 | 运行方式 |
| --- | --- | --- |
| `/shell <command>` | 在 bash 中运行 POSIX 命令 | `bash -c <command>` |
| `/cmd <command>` | 在 cmd.exe 中运行 Windows 命令 | `cmd.exe /d /s /c <command>`（仅 Windows） |
| `/pwsh <command>` | 在 PowerShell 中运行命令 | `pwsh -NoProfile -Command <command>`（可执行文件自动解析，固定 UTF-8 输出） |

`/shell` 跨平台运行，需要 `bash` 在 PATH 上（Windows 上通常是 git bash）。`/cmd` 仅在 Windows 可用，其他平台明确报错。`/pwsh` 在 Windows 上自动解析 PowerShell 可执行文件：优先 PowerShell 7（`pwsh`），其次 PATH 上的 `pwsh.exe`（含 Microsoft Store 别名），都没有时回退到 Windows PowerShell 5.1（`powershell.exe`）；其他平台需要 `pwsh` 在 PATH 上。

命令文本保留引号和内部空白。例如：

```text
/shell echo "  spaced  " && echo done
/cmd dir /b /s
/pwsh Get-Process | Select-Object -First 3
```

## 语法说明

DSH 的命令解析器要求命令名后必须有空白，所以 `/shell:ls`（无空格）不会被识别为命令，会作为普通文本发给模型。可用的形式是空格分隔：

```text
/shell ls -la
/cmd dir
/pwsh Get-Process
```

作为善意兼容，parser 容忍命令名后单个前导冒号，`/shell :ls -la` 与 `/shell ls -la` 等价。若命令本身以 `:` 开头，请使用纯空格形式。

## 工作原理

插件由 Host 和 Client 两部分组成，两部分使用不同的 Cordis context，不能混用：

```text
Host
  ctx.commands        注册和执行 /shell、/cmd、/pwsh
  runner registry      将命令名映射到 spawn 配方
  child_process        在会话 cwd 下启动子进程并收集输出

Client
  ctx.commandUi        将 /shell、/cmd、/pwsh 装饰到 / 命令菜单
  ctx.slots            为三个命令注册自定义结果卡片（标题显示输入命令）
  ctx.sessions        定位当前会话并回填输入框
```

执行流程：

```text
用户输入 /shell ls -la
  ↓
DSH Web command UI 展示候选并回填前缀
  ↓
用户补全命令文本并手动发送
  ↓
Host ctx.commands.execute() 解析为 shell 命令
  ↓
runner.build() 生成 spawn 配方 { file, args }
  ↓
child_process.spawn 在会话 cwd 下运行
  ↓
收集 stdout/stderr，应用超时与输出上限
  ↓
返回 CommandResult，记录 command/done
  ↓
Client 注册的命令卡片渲染标题 `cmd "dir"` + 结果
```

### 子进程与结果回传

`command/done` 事件携带 `{ kind, text }`，`text` 包含退出码横幅、stdout、stderr 分段以及超时/取消/截断标记。Web UI 的命令结果渲染器负责展示，无需额外客户端抓取逻辑。

成功（退出码 0）返回 `kind: 'success'`，非零退出码或超时、取消、spawn 失败返回 `kind: 'error'`，但 `text` 始终包含已收集的输出。

### 命令结果卡片

DSH 默认的命令结果卡片标题只显示命令名（`cmd`）。本插件在 Client 侧向 `conversation.chat.commandview` slot 注册自定义卡片，标题改为「命令名 + 输入原文」——`/cmd "dir"` 显示为 `cmd "dir"`，`/shell ls -la` 显示为 `shell ls -la`。

- 输入原文来自 `command/run` 事件的 `args`（`parseCommand` 的 verbatim `rawInput`，含分隔空格），已随事件记录，无需改动 Host 或会话日志。
- 卡片复用 ui-chat 的 `chat` locale 字典（`command.running` / `command.done` / `command.failed`）与 `ui-primitives` 的 `DisclosureRow`，因此状态文案与通用卡片一致，且随语言切换更新。
- 卡片按命令名 keyed 注册（`cmd`、`shell`、`pwsh`），只替换本插件三个命令的渲染；其他命令不受影响。

执行边界：

- 工作目录取 `agent.session.header.cwd`；
- 30 秒硬超时，到期 `SIGKILL` 杀死子进程并标记 `[timed out]`；
- 输出上限 1 MiB，超额标记 `[output truncated]`；
- 监听 `invocation.signal`，UI 取消请求即 `SIGKILL` 并标记 `[aborted by caller]`；
- 子进程 stdio 为 `['ignore', 'pipe', 'pipe']`，不等待 stdin；
- `/pwsh` 在每条命令前固定 `[Console]::OutputEncoding` 与 `$OutputEncoding` 为 UTF-8，非 ASCII 输出按 UTF-8 返回，不依赖解码回退。

## 安装前提

- Node.js；
- 已安装 DSH `0.1.1-rc.2` 或兼容版本；
- 已存在 DSH Web profile；
- Web profile 已组合 commands 和 command UI 相关插件；
- `/shell` 需要 `bash` 可执行；`/cmd` 需要 Windows；`/pwsh` 需要 PowerShell 可执行（Windows 上 PowerShell 7 与 Windows PowerShell 5.1 任一可用即可）。

检查可执行是否可用：

```bash
bash --version
pwsh --version
```

`pwsh --version` 失败不必然代表 `/pwsh` 不可用：Windows 上 Microsoft Store 安装的 `pwsh` 是一个应用执行别名，裸命令名与 `where.exe` 都可能找不到它，但插件按绝对路径解析后仍可执行（见[故障排查](#pwsh-报-pwsh-not-found-on-path)）。

检查 DSH CLI：

```bash
dsh --version
dsh plugin --help
```

## 从本地目录安装

进入本插件目录确认路径：

```bash
cd $localPath/dsh-quick-shell
pwd
```

安装到 Web profile：

```bash
dsh plugin --profile web add "$PWD"
```

也可以从任意目录使用绝对路径：

```bash
dsh plugin --profile web add $localPath/dsh-quick-shell
```

`package.json` 中的 `dsh.bundle.patch` 会让 DSH profile 识别 `cordis.patch.yml`；`dsh.client` 元数据会让 Web profile 构建并加载 `client/client.js`。

安装后启动 Web：

```bash
dsh web --no-open
```

访问终端输出的地址，通常是：

```text
http://127.0.0.1:3080
```

不要在同一个 profile 上重复启动多个 Web 实例。已有实例时先停止旧实例，避免端口、session 或 task-board ledger 锁冲突。

## 从 Git 仓库安装

远程仓库创建后：

```bash
dsh plugin --profile web add <repository-url>
```

例如：

```bash
dsh plugin --profile web add https://github.com/<org>/dsh-quick-shell.git
```

固定分支、tag 或 commit：

```bash
dsh plugin --profile web add 'git+https://github.com/<org>/dsh-quick-shell.git#main'
```

建议生产环境固定到经过验证的 tag 或 commit。

## 更新、移除和查看安装状态

```bash
dsh plugin --profile web list
dsh plugin --profile web update dsh-quick-shell
dsh plugin --profile web remove dsh-quick-shell
```

若当前 DSH 版本的 `list`、`update` 或 `remove` 参数形式不同，先运行：

```bash
dsh plugin --help
dsh plugin --profile web --help
```

移除后重启 Web profile，确保 Host 注册和 Client bundle 都被卸载：

```bash
dsh web --no-open
```

## Web 使用和验收

### 一级命令

在 DSH Web 输入框输入：

```text
/
```

应能看到可用命令候选，包括：

```text
/shell
/cmd
/pwsh
```

输入 `/sh` 应过滤到 `/shell`。

### 命令执行

1. 输入 `/shell`；
2. 选择候选，输入框回填 `/shell `；
3. 继续输入命令，例如 `/shell ls -la`；
4. 手动发送。

选择候选只会回填前缀并交还输入焦点，不会自动发送，也不会在选择瞬间启动子进程。

### 命令事件

成功执行后，会话日志应能看到成对的：

```text
command/run(name=shell)
command/done
```

命令结果直接返回命令 UI，不自动变成模型历史消息。

## 开发和测试

安装依赖后运行测试：

```bash
npm test
npm run test:parser
git diff --check
```

当前测试覆盖：

- Slash parser 和错误边界；
- runner 注册表、spawn 配方、PowerShell 可执行文件解析顺序和 UTF-8 输出固定；
- Host 命令注册和 handler 委派；
- 子进程 stdout/stderr 收集、退出码、超时、取消、截断、ENOENT；
- 会话 cwd 传递；
- Web 候选装饰和输入框回填；
- 命令卡片标题拼接输入原文、running/成功/错误的 summary 与展开行为；
- Host/Client 入口契约。

`dsh-adapter` 的 spawn 通过 `options.spawn` 注入桩函数测试，不触达真实进程表，测试可在任意平台稳定通过。

仓库是 JavaScript ESM 插件，不要求提交 `node_modules`、构建缓存或用户运行数据。

## 故障排查

### `/shell ls` 被模型当作普通问题回答

检查：

1. 插件是否安装到正在运行的 `web` profile，而不是其他 profile；
2. `dsh plugin --profile web list` 是否能看到插件；
3. Web 是否在安装后重启；
4. 浏览器是否强制刷新；
5. 会话日志是否有 `command/run(name=shell)` 和 `command/done`；
6. 是否误把 `/shell:ls`（无空格）当成本插件接口。

`/shell:ls`（无空格）不会被 DSH 识别为命令。改为 `/shell ls` 或 `/shell :ls`。

如果没有 `command/run`，通常说明当前 Web 进程没有加载插件或客户端仍使用旧命令目录。停止旧 Web 实例，重新执行安装和启动，再 `Ctrl+Shift+R` 刷新浏览器。

### `/shell` 报 bash not found

`/shell` 需要 `bash` 在 PATH 上。Windows 上安装 git bash 或 WSL bash 后确认 `bash --version` 可用。`/cmd` 不依赖 bash，`/pwsh` 不依赖 bash。

### `/pwsh` 报 pwsh not found on PATH

Windows 上出现这个横幅，说明解析链里没有任何可执行的 PowerShell。`/pwsh` 按以下顺序解析，取第一个存在的可执行文件：

1. `%ProgramFiles%\PowerShell\7\pwsh.exe`（PowerShell 7 常规安装）；
2. PATH 上每个目录下的 `pwsh.exe`（覆盖 Microsoft Store 应用执行别名）；
3. `%SystemRoot%\System32\WindowsPowerShell\v1.0\powershell.exe`（Windows PowerShell 5.1 兜底）。

三者都不存在时才回退到裸 `pwsh` 并报此错误。排查：

- 确认 `C:\Program Files\PowerShell\7\pwsh.exe` 是否存在，或 `powershell.exe` 是否可用；
- Microsoft Store 版 PowerShell 7 的别名可能无法被裸 `pwsh` 或 `where.exe pwsh` 找到，这不影响插件，插件按绝对路径解析后即可执行；
- 安装 PowerShell 7：`winget install --id Microsoft.PowerShell`；
- 注意 Windows PowerShell 5.1 与 PowerShell 7 在语法和输出编码默认值上有差异，回退到 5.1 时命令行为可能不同。

### `/pwsh` 输出乱码

`/pwsh` 在每条命令前固定 UTF-8 输出编码，正常情况下非 ASCII 输出不会乱码。若仍出现乱码，检查：

- 命令首行是否使用 `param(...)`、`#requires` 或 `using`——PowerShell 要求这些语句位于脚本最顶部，编码前置语句会拦住它们；把 `param(...)` 脚本包进 `& { ... }`，或改用脚本文件执行；
- 命令自身是否重新指定了输出编码（例如再次调用 `chcp`，或重新赋值 `[Console]::OutputEncoding`）。

### 命令长时间运行无响应

默认 30 秒硬超时到期会 `SIGKILL` 子进程并返回 `[timed out after 30000ms]`。如需更长时间，应在 `createDshAdapter` 的 `options.timeoutMs` 中调整，或把命令改为后台运行并自行重定向输出。

### 候选框没有出现

检查：

- Web profile 是否组合 command UI；
- Client bundle 是否在插件安装后重新生成；
- `package.json` 中的 `dsh.client` 元数据是否被 profile 读取；
- 浏览器控制台是否出现 `[dsh-quick-shell]` 日志；
- 是否注册了重复的 input source。

本插件使用 `ctx.commandUi.decorate()`，不重复注册 `/` 输入 source。

### 命令结果卡片不显示输入命令

命令卡片的标题来自 `command/run` 事件的 `name` + `args`。若标题只有命令名：

- 确认 Web 客户端加载的是最新 `client/client.js`（需要重新生成 client bundle 后强制刷新）；
- 确认 profile 组合了 ui-chat（提供 `conversation.chat.commandview` slot）与 locale 插件；
- 浏览器控制台是否出现 `[dsh-quick-shell] command decorations and command cards registered`；
- 命令是否设置了 `recordInput: false`（本插件三个命令都没有）。

### 依赖或 profile 锁冲突

不要提交或复制以下运行数据到仓库：

```text
~/.dsh/ledger
~/.dsh/*.lock
~/.dsh/profiles/web
~/.dsh/sessions
~/.dsh/cache
node_modules
```

关闭旧的 DSH Web 进程后再执行 profile 安装或更新。

## 项目结构

```text
.
├── client/
│   ├── client.js             # Web ModuleLoader 入口（装饰 + 命令卡片）
│   └── index.js              # 可测试 Client 实现
├── src/
│   ├── index.js              # Host 插件入口
│   ├── command-runtime.js    # 命令注册和 handler 委派
│   ├── dsh-adapter.js        # 子进程 spawn 与输出收集
│   ├── parser.js             # 纯函数 Slash parser
│   └── runners.js            # runner 注册表（shell/cmd/pwsh）
├── test/                     # Node 合同测试
├── cordis.patch.yml          # DSH profile bundle patch
├── package.json              # 插件和 DSH bundle metadata
└── README.md
```

## 安全和设计边界

- UI 候选不是授权边界，Host 必须重新解析和校验；
- 子进程在会话 cwd 下运行，继承 harness 进程环境；
- 非零退出码返回 `kind: 'error'`，但完整返回已收集的输出；
- 超时、取消、截断、spawn 失败都明确标记，不静默吞掉；
- `bash`、`cmd.exe`、PowerShell 不可用时返回明确错误，不静默跳过；
- 命令结果不自动变成模型历史消息，需要继续 Agent 工作时应显式提交受支持的 Agent 输入；
- 候选选择与命令执行分离；
- runner 注册表是数据，`build()` 只返回 spawn 配方，收集、超时、取消由 adapter 统一负责。
