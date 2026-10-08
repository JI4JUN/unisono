# Unisono MVP — Spec

> **状态**: 待研发 / 由 [`unisono-handoff.md`](../unisono-handoff.md) 裁切而成
> **Slogan**: *One score. Two agents in unison.*
> **定位**: 声明式 OMP + Pi Provider 配置编译器
> **运行环境**: Bun ONLY（纯 CLI，零 Daemon）
> **术语**: 遵循 [`GLOSSARY.md`](../GLOSSARY.md)；**接管**语义遵循 [`docs/adr/0001-takeover-instead-of-merge.md`](./adr/0001-takeover-instead-of-merge.md)

---

## 0. 改动摘要：相对 handoff 文档裁掉了什么

| 项 | Handoff 原设计 | MVP 决定 |
|---|---|---|
| Agent 数量 | 5 个（omp, pi, opencode, hermes, openclaw） | **2 个**：omp, pi |
| 单次同步 | 5 端异构 schema 映射 | omp/pi 的 Catalog 树结构一致，仅差序列化格式（见 §3.1） |
| Phase 2 | 扩展 Adapter（Continue/Aider/Crush/Codex）+ `unis ping` | 移除 |
| Phase 1B | 4 个 Adapter 平行铺开 + 悬空引用告警 | 仅 PiAdapter；悬空检查限于 omp `config.yml` / pi `settings.json` |
| §4 agents 开关 | Score 内 `agents.<id>.enabled/path` | 保留路径探测，移除 `enabled` 开关 |
| §7 容错 | 接管拦截 + 原子快照 + 乐观锁 + 软链接 | 四项全留；备份轮转 10 → 3 |
| §9 Checklist | 4 Step / Phase 1A+1B | 4 Step，omp 闭环先行、pi 收尾 |
| UI 形态 | Phase 2 Web UI + CLI + 原生 | 仅纯文本 CLI；无 TUI、无 Web UI、无桌面端 |

**保留不裁的核心**：Catalog 全权接管（对应 ADR 0001）+ 非 Catalog 节点 100% 保留；Score 单一真实源；Override 深合并；`${ENV}` 编译期展开、缺失即报错；`import` 反向生成；`sync`/`diff`/`validate`/`list`/`rollback`。

---

## 1. 目标与非目标

### 1.1 目标（MVP 验收边界）
1. 用户维护**一份** Score，一次 `unis sync` 后 omp 与 pi 的 provider 目录内容一致（仅序列化格式不同）。
2. 两个 Agent 的 Catalog 之外节点（omp `modelOverrides`、`config.yml`；pi `settings.json` 等）**零改动**。
3. 第二次 `unis sync`（无编辑）对两个 Agent 均输出 `Unchanged`，**零磁盘写入**。
4. `unis import omp` 能从现有 omp 配置反向生成可用的 Score 草稿（含 `overrides.omp`）。
5. 误删保护：首次接管前可 `unis rollback` 恢复。

### 1.2 非目标（MVP 明确不做）
- opencode / hermes / openclaw 任何支持，包括探测、告警。
- **交互式 TUI**：MVP 全命令走纯文本 CLI。不做常驻界面、不做 watch 自动刷新、不做全屏界面。
- Web UI、Tauri、桌面端；周期任务；`unis ping`。
- `--only` 多 Agent 选择（MVP 恒同步两个）。
- 评分式模型推荐（stay_out）。
- 保注释/保格式的保留式写回。

---

## 2. 统一数据契约：Score

唯一路径 `$XDG_CONFIG_HOME/unisono/score.yaml`（未设置时 `~/.config/unisono/score.yaml`）。

```yaml
version: "1"                      # 必填，仅接受 "1"

providers:
  deepseek:
    name: "DeepSeek Official"     # 必填，非空字符串
    baseUrl: "https://api.deepseek.com/v1"
    apiKey: "${DEEPSEEK_API_KEY}" # 必填；${VAR} 编译期展开为明文；未定义/空串 → 报错中止
    apiType: "openai-completions" # 必填：openai-completions | openai-responses | anthropic-messages
    headers: {}                   # 可选：自定义 HTTP 头
    overrides:                    # 可选：Agent 专有字段，编译期深合并，同名键优先
      omp:
        compat:
          supportsDeveloperRole: false
    models:                       # 必填，至少 1 项
      - id: "deepseek-chat"       # 必填，provider 内唯一
        name: "DeepSeek V3"       # 必填
        contextWindow: 65536      # 必填，正整数
        maxTokens: 8192           # 可选，正整数
        reasoning: false          # 可选，布尔
        overrides:                # 可选，同上
          omp:
            input: ["text"]
            cost: { input: 0.55, output: 2.19, cacheRead: 0.14, cacheWrite: 0 }
            thinking:
              mode: "effort"
              efforts: ["low", "medium", "high"]
              effortMap: { low: "low", medium: "medium", high: "high" }
```

### 2.1 校验规则（`unis validate` 与 `unis sync` 共用）
| 规则 | 失败行为 |
|---|---|
| `version` 缺失或 ≠ `"1"` | 报错中止，列出实际值 |
| `providers` 缺失或空对象 | 报错中止 |
| provider 缺 `name`/`baseUrl`/`apiKey`/`apiType`/`models` 任一 | 报错中止，标注 `<provider>.<field>` |
| `apiKey` 模板引用变量未导出或为空串 | 报错中止，列出变量名 |
| `apiType` 不在枚举内 | 报错中止 |
| model 缺 `id`/`name`/`contextWindow`，或同 provider 内 `id` 重复 | 报错中止 |
| 未知顶层键、未知 provider/model 字段 | **警告**（不中止），提示可能拼写错误 |
| `contextWindow`/`maxTokens` 非正整数 | 报错中止 |

### 2.2 展开与脱敏
- `${VAR_NAME}` 唯一支持的模板语法；展开发生在编译前，产物为明文字符串。
- 展开失败（未定义或空串）→ 中止，**不写任何文件**。
- 日志与 `unis diff` 输出中，`apiKey` 字段一律渲染为 `sk-ab***12cd`（保留前 5 + 后 4 字符，不足则全星号）。

---

## 3. 两个 Agent 的编译契约

### 3.1 为什么 MVP 只需要两个 Adapter 骨架
omp 与 pi 的 Catalog 均为**同一棵树**：

```text
providers.<id>:
  name? / baseUrl / api / apiKey / headers?
  models[]: { id, name, contextWindow, maxTokens, reasoning, ...overrides }
```

差异只有三点，全部收在 Adapter 内：
1. **路径**：omp = `~/.omp/agent/models.yml`；pi = `~/.pi/agent/models.json`。
2. **序列化**：YAML ↔ JSON(2 空格缩进)。
3. **转义**：pi 的 `resolveConfigValue` 会把 `!` 开头的字符串当 Shell 执行、把 `$VAR` 当环境变量展开 → 写入 pi 的 `apiKey`/`headers` 值必须转义：`!` 开头 → `$!`；任意 `$` → `$$`。（omp YAML 无此行为。）

### 3.2 OmpAdapter
- **探测**：`$OMP_CODING_AGENT_DIR/models.yml`，否则 `~/.omp/agent/models.yml`；仅存在 `models.yaml` 时读写该文件。
- **Catalog Key**：顶层 `providers` 整块替换。
- **保留**：顶层其他键（如 `modelOverrides`）100% 原样。
- **读取**：`Bun.YAML.parse`；写回 YAML。
- **悬空引用检查**：读同目录 `config.yml`，提取 `modelRoles`（格式 `<provider>/<model>[:thinking]`）与 `enabledModels`；凡引用本次被移除的 provider/model → 告警，**不修改**。

### 3.3 PiAdapter
- **探测**：`$PI_CODING_AGENT_DIR/models.json`，否则 `~/.pi/agent/models.json`。
- **Catalog Key**：顶层 `providers` 整块替换。
- **保留**：顶层其他键 100% 原样。
- **读取**：Pi 容忍 `//` 注释与尾逗号 → 使用 `Bun.JSONC.parse`（Rust 实现，一并处理注释、尾逗号与引号容错；实测 500 次解析 0.7ms）。**禁止**自行剥离注释后用 `JSON.parse`——实测 `JSON.parse` 对尾逗号直接 `SyntaxError`，而 Pi 官方容忍尾逗号。写回标准 2 空格 JSON。
- **转义**：见 §3.1 第 3 点，仅作用于写入值。
- **悬空引用检查**：读同目录 `settings.json` 的 `defaultProvider` / `defaultModel`；引用被移除项 → 告警。

### 3.4 编译产物（两 Agent 语义等价）

```yaml
# omp: ~/.omp/agent/models.yml
providers:
  deepseek:
    name: "DeepSeek Official"
    baseUrl: "https://api.deepseek.com/v1"
    api: "openai-completions"
    apiKey: "sk-expanded-plaintext..."
    headers:
      User-Agent: "Unisono-Sync/1.0"
    compat:                       # ← 来自 overrides.omp 深合并
      supportsDeveloperRole: false
    models:
      - id: "deepseek-reasoner"
        name: "DeepSeek R1 (Reasoning)"
        contextWindow: 65536
        maxTokens: 8192
        reasoning: true
        input: ["text"]           # ← overrides.omp
        cost: { input: 0.55, output: 2.19, cacheRead: 0.14, cacheWrite: 0 }
```

```json
// pi: ~/.pi/agent/models.json
{
  "providers": {
    "deepseek": {
      "name": "DeepSeek Official",
      "baseUrl": "https://api.deepseek.com/v1",
      "api": "openai-completions",
      "apiKey": "sk-expanded-plaintext...",
      "headers": { "User-Agent": "Unisono-Sync/1.0" },
      "models": [
        { "id": "deepseek-reasoner", "name": "DeepSeek R1 (Reasoning)",
          "contextWindow": 65536, "maxTokens": 8192, "reasoning": true }
      ]
    }
  }
}
```

### 3.5 判等（决定是否写盘）
对每个 Agent：解析现有文件 → 取 Catalog 子树 → 深合并 Override 得到"期望 Catalog" → 与**实际** Catalog 深比较。相等 ⇒ 不备份、不写盘、输出 `Unchanged`。比较在解析后的数据结构上进行，与缩进、键序无关（键序不同不算变更）。

---

## 4. CLI 规格

二进制名 `unis`（MVP 单名，不注册 `unisono` 别名）：

```bash
unis sync                 # 同步 omp + pi（含首次接管检查）
unis sync --yes           # 确认接管：目标 Catalog 含未在 Score 声明的 provider 时强制写入
unis sync --dry-run       # 预览 diff，脱敏，不写盘
unis import [agent]       # agent ∈ {omp, pi}；反向生成 Score 草稿（含 overrides）
unis diff                 # Score 编译结果 vs 两 Agent 实际 Catalog 的语义差异
unis validate             # Score 语法/必填/环境变量校验 + 悬空引用告警
unis list                 # 探测两 Agent：路径、是否存在、Catalog 同步状态
unis rollback             # 回滚到最近一次同步前
unis rollback --list      # 历史快照时间戳（保留最近 3 次）
unis rollback <timestamp> # 回滚到指定快照
```

### 4.1 输出契约
```
🎼 Unisono v0.1.0 — One score. Two agents in unison.

✓ [Score]   ~/.config/unisono/score.yaml            (2 providers, 3 models)
✓ [OMP]     ~/.omp/agent/models.yml                 -> Synced (2 providers, 3 models)
✓ [Pi]      ~/.pi/agent/models.json                 -> Unchanged
⚠ [Pi]      settings.json defaultModel references removed provider 'old-proxy'

Backup saved: ~/.config/unisono/backups/2026-10-08T12-00-00-000Z/
✨ In unison! (12ms)
```

- 单次 `unis sync` 总耗时 ≤ 100ms（两台均已同步的常规情况）。
- 状态词：`Synced` / `Unchanged` / `Skipped (not installed)` / `Failed`。

### 4.2 退出码
| 码 | 含义 |
|---|---|
| 0 | 全部成功或 Unchanged；validate 仅有告警 |
| 1 | 校验失败 / 环境变量缺失 / 写盘失败 |
| 2 | 首次接管未确认被拦截（列出待删 provider 清单，提示 `--yes` 或先 `import`） |

---

## 5. 安全与完整性（全部保留，参数收紧）

1. **首次接管拦截**：任一 Agent 的现有 Catalog 含未在 Score 声明的 provider ID → 默认拒绝写入，退出码 2，列出清单。`--yes` 或先 `unis import <agent>` 后放行。
2. **写前原子快照**：写入前将本次涉及变更的 Agent 原文件备份至 `$XDG_CONFIG_HOME/unisono/backups/{ISO 时间戳（`:`→`-`）}/{omp|pi}.<ext>`；manifest 记录原本不存在的文件（回滚时删除）。保留最近 **3** 次。
3. **乐观锁**：读文件时记 SHA-256；临时文件 `rename` 原子替换前复核磁盘哈希，被外部修改 → 中止报错。
4. **软链接安全**：`realpath` 解析后在真实文件**同目录**建临时文件并替换，不破坏链接。
5. **凭证卫生**：备份目录 `0700`，备份文件与写出的目标配置 `0600`；`diff`/日志脱敏（§2.2）。
6. **幂等**：仅 Catalog 语义不等才备份与写盘；写回不保留注释（已接受的取舍）。

---

## 6. 依赖策略：零运行时依赖

所有能力由 Bun 内置 API 覆盖（Bun 1.4.2 实测）：

| 能力 | 方案 | 实测 |
|---|---|---|
| YAML 解析/序列化 | `Bun.YAML.parse` / `Bun.YAML.stringify(v, null, 2)` | Rust 实现，过官方 YAML 测试套件；500 次 parse = 1.1ms |
| 带注释 JSON 读取 | `Bun.JSONC.parse`（见 §3.3） | 500 次 = 0.7ms；一并处理注释、尾逗号、引号容错 |
| CLI 参数 | `Bun.argv` + 手写路由 | 7 子命令 + 3 flag，~40 行 |
| 深比较 / 深合并 | `src/merger.ts` 内手写 | 1000 次双层 40-model 比较 = 21.6ms |
| `${ENV}` 展开 | `replace(/\$\{(\w+)\}/g)` + `process.env` | 单次 sync 序列化开销 0.07ms，100ms 预算占 0.07% |

**禁止引入**（实测无增量价值）：`citty`（52KB，手写更短）、`yaml`/eemeli（1.2MB，唯一增量是 `lineWidth:0`，而内置 stringify 默认不折行）、`zod`/`valibot`（8 条静态规则手写 ~60 行，错误信息更可控）、`jsonc-parser`（内置即其 Rust 移植）、`chalk`/`picocolors`（4 个状态词用 ANSI 字面量）、`fast-deep-equal`、`strip-json-comments`（**不处理尾逗号**，功能不足）。

**devDependencies 也为空**——测试走内置 `bun:test`。

---

## 7. 目录结构

```text
unisono/
├── GLOSSARY.md
├── docs/
│   ├── mvp-spec.md            # 本文
│   └── adr/0001-takeover-instead-of-merge.md
├── package.json               # bin: { "unis": "./src/cli.ts" }
├── tsconfig.json
├── types/
│   └── bun.d.ts               # 手写 ambient 声明（零 devDependencies，无 @types）
├── src/
│   ├── cli.ts                 # 入口 + 命令路由、状态行、接管拦截
│   ├── paths.ts               # XDG 与 Agent 路径探测
│   ├── score.ts               # Score 类型、校验、${ENV} 展开（与类型同变，故合一）
│   ├── guards.ts              # 解析产物的规范 narrow helper
│   ├── compiler.ts            # Score → Catalog（Agent 无关）
│   ├── merger.ts              # Override 深合并、Catalog 判等
│   ├── mask.ts                # 凭证脱敏渲染
│   ├── agent.ts               # Catalog 读取、计数
│   ├── sync.ts                # omp YAML 文本拼接接管
│   ├── pi-write.ts            # pi JSONC 文本拼接接管 + !/$ 转义
│   ├── writer.ts              # 原子写、乐观锁、软链接、0600
│   ├── backup.ts              # 快照、3 次轮转、rollback
│   ├── importer.ts            # import → Score 草稿
│   ├── dangling.ts            # omp config.yml / pi settings.json 悬空引用告警
│   └── output.ts              # 纯文本输出契约（NO_COLOR / 非 TTY 抑制 ANSI）
└── test/                      # 唯一接缝：驱动真实二进制为子进程，per-test tmpdir
    ├── list.test.ts
    ├── validate.test.ts
    ├── diff.test.ts
    ├── sync.test.ts
    ├── pi-write.test.ts
    ├── rollback.test.ts
    ├── import.test.ts
    └── e2e.test.ts            # 端到端契约（#11）
```

**与初版 §7 的差异**（以已发布 spec #1 的 Testing Decisions 与代码现状为准）：

| 初版列出 | 实际 | 原因 |
|---|---|---|
| `types.ts`（Score/Provider/Model/Override/Adapter 类型） | `score.ts` 内联同文件类型 | Score 类型只服务于其 reader，二者同变；§2 已注明此合一 |
| `adapters/base.ts` + `omp.ts` + `pi.ts`（`AgentAdapter` 接口） | 无接口层。差异化行为收敛为 `agent.ts`（解析）、`sync.ts`（omp 写）、`pi-write.ts`（pi 写） | 只有 2 个 Agent 且结构同树（§3.1），抽象失去客户；接口的唯一实现者就是抽象本身 |
| `merger.ts` 承担原子写 + 0600 | `writer.ts` | 写入原语与判等不同关注点，且 backup/rollback 也需要它 |
| 无 `compiler.ts` | `compiler.ts` | 编译与 Agent 读写分离，`diff` 才能不写盘推理 |
| `cli.test.ts` | 按命令分文件 | 单一 CLI 接缝不变；按命令划分避免单文件膨胀 |
| 无 `dangling.ts` / `mask.ts` / `output.ts` / `guards.ts` / `pi-write.ts` / `e2e.test.ts` | 逐一落地 | 见对应工单 |

`AgentAdapter` 接口（MVP 裁剪版）**未实现**：两个 Agent 的 Catalog 是同一种树（§3.1），差异化行为只剩三处——路径、序列化、转义——其中路径归 `paths.ts`，序列化与转义归各自的写模块（`sync.ts` / `pi-write.ts`），解析归 `agent.ts`。抽象的每个方法都只有一个客户，接口本身即是它唯一的实现者。若 Phase 2 加入异构 schema 的 Agent，再在那些写模块之上提取接口。

> **测试布局以已发布 spec #1 的 Testing Decisions 为准：单一 CLI 接缝。** 测试驱动真实 `unis` 二进制作为子进程，指向 per-test 临时目录，断言最终文件、权限、输出与退出码；不 import 内部模块，不断言源码文本。按命令分文件（`list` / `validate` / `diff` / `sync` / `pi-write` / `rollback` / `import`），`e2e.test.ts` 单列以承载只存在于跨命令与整轮层面的契约（幂等零写、退出码、权限、保留字节、脱敏、计时）。而非按内部模块分文件——后者需要重复 fixtures、与实现结构平行，且无法断言退出码与输出。

---

## 8. 实施 Checklist（4 Step）— 全部完成

- [x] **Step 1**: 脚手架 + `paths.ts` / `score.ts`（初版所列 `types.ts`+`parser.ts` 合一为 `score.ts`，见 §7 差异表）。**验证**：`unis validate` 对缺失变量/非法 version/重复 model id 报错。
- [x] **Step 2**: OMP 纵向闭环 — `backup.ts` / `merger.ts` / `writer.ts` / `importer.ts`（无 `adapters/omp.ts`，见 §7 差异表）；首次接管拦截、软链接、乐观锁、0600。**验证**：`import → validate → diff → sync → rollback` 全通；两次 sync 第二次 `Unchanged`；`modelOverrides` 与 `config.yml` 零改动。
- [x] **Step 3**: PiAdapter — JSONC 注释/尾逗号解析、`!`/`$` 转义、`settings.json` 悬空告警、2 空格 JSON 写回。**验证**：pi 单测覆盖转义矩阵（`!abc`、`a$b`、`a!b$c`、无特殊字符，及 `$!a$$b` 的组合边界）；两 Agent 编译产物共有字段语义等价。
- [x] **Step 4**: CLI 组装 + 端到端 — `sync [--yes] [--dry-run]`、`import`、`diff`、`validate`、`list`、`rollback`；退出码 §4.2。**验证**：`bun test` 163 全绿；`--dry-run` 零写入；未确认接管退出码 2；同步计时 ~10ms（≤100ms）。

---

## 9. 验收标准（Definition of Done）— 全部达成

1. **达成** — `unis sync` 后两文件 Catalog 共有字段语义等价且符合 §3.4 形状（`apiType`→`api`、Override 深合并到位）；两文件非 Catalog 节点逐字节不变。两点注记：Agent 专有字段（`overrides.omp`）按设计仅落 omp，§3.4 本身即如此示例；另有一个接受的例外——当某 Agent 文档把自己的闭合括号与其内容写在同一行（`{ "settings": {...} }`）时，该形状没有可供文本拼接的换行结构，此时重新序列化整个文档，节点全部保留但空白与注释性格式不保留。逐字节不变对逐行键的文档成立。
2. **达成** — 立即重跑输出 `Unchanged`（两侧），两文件 mtime 不变，无新备份目录。
3. **达成** — `unis validate` 六类失败场景全部报错并退出 1（version / 缺必填 / 重复 id / apiType 越界 / contextWindow 非正 / 变量未定义）；仅告警时退出码 0。
4. **达成** — `unis import omp` 从 2 providers / 3 models / `overrides.omp` 样本生成 Score，validate 通过，`import → sync` 后 Catalog 与原样本语义一致。
5. **达成** — 未声明的 provider 触发接管拦截：未加 `--yes` 退出码 2 且零写入、零快照；加 `--yes` 后写入并留快照。
6. **达成** — `unis rollback` 恢复两文件至 sync 前内容（字节与权限）。原本不存在的文件被删除一项：工具不会为 `not installed` 的 Agent 创建配置，因此该路径需经 manifest 的 `backed` 缺失分支验证，已由 `restoreSnapshot` 的清单语义覆盖。
7. **达成** — pi `settings.json` 的 `defaultProvider`/`defaultModel` 指向被删 provider 时 warn，且 `settings.json` 不被改写；omp `config.yml` 的 `modelRoles`/`enabledModels` 同样。
8. **达成** — `bun test` 163 全绿；fixtures 覆盖 omp YAML、pi 带 `//` 注释与尾逗号的 JSON、含 `!`/`$` 的 key；均为脱敏样本，无真实凭证。
9. **达成** — 所有命令在管道/重定向下输出纯逐行文本，无 ANSI 转义（非 TTY 或 `NO_COLOR` 均抑制），无清屏/光标控制/常驻循环。
