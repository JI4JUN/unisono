# Unisono (`unis`) - 产品需求文档 (PRD) & 架构工程交接

> **Slogan**: *"One score. All agents in unison."* (一份总谱，万部和鸣)  
> **项目定位**: 声明式多 Agent LLM 配置编译器（Declarative Multi-Agent Model Configuration Compiler）  
> **CLI 别名**: `unis` / `unisono`  
> **当前状态**: 已立项 / 方案终审通过 / 进入 Phase 1 工程研发  
> **核心运行环境**: **Bun ONLY** (`bun run`, `bun test`, 零外部常驻 Daemon)

---

## 1. 业务背景与问题定义 (Context & Problem)

### 1.1 现状与痛点
在当前的 AI 编程生态中，开源终端 Agent（如 `pi`, `omp`, `opencode`, `hermes`, `openclaw`）凭借可定制性和无黑盒特质被极客开发者广泛采用。然而，多 Agent 协同工作流面临三大严峻阻碍：

1. **网关黑盒削足适履（Gateway Latency & Context Degradation）**：
   - 依赖集中式网关（如 LiteLLM、Bifrost）只暴露单一端点，抹平了各模型的物理上限。
   - Coding Agent 严重依赖准确的本地元数据：上下文窗口（`contextWindow`）直接决定 AST 局部剪枝、代码搜索预算和 `auto-compact` 压缩时机；
   - 思考能力（`reasoning: boolean`、`reasoning_effort`、`<think>` 块解析）协议在不同模型间差异极大。网关隐藏这些参数会导致 Agent 频繁触发 400 溢出崩溃或过早压缩丢失长程记忆。
2. **切换工具的“单选覆写”缺陷（The Single-Active Provider Flaw）**：
   - 现有管理工具（如 `coder-link`、`CC Switch`）本质是为单通道商业工具（Claude Code/Codex）设计的“全局切换器”；
   - 源码逻辑是“切到 A 供应商时，直接清空并覆写其他所有供应商”，导致 Agent 会话内的 `/model` 候选菜单被清空；
   - 无法满足“终端窗口 1 在工作区 A 跑 DeepSeek-R1 重构后端，终端窗口 2 在工作区 B 跑 GLM-4-Flash 刷单测”的**跨工作区并发诉求**。
3. **多端配置割裂与维护焦虑**：
   - 每个 Agent 的配置语法各异（Pi 是 JSON 数组、OMP 是 YAML 字典、OpenCode 是 `@ai-sdk/openai-compatible` 字典、Hermes 是 YAML 数组、OpenClaw 是 JSON5）；
   - 用户轮换一次 API Key 或新增一个模型，必须手工编辑 5 个甚至更多配置文件，极易出错。

### 1.2 核心破局思路：配置编译与累加式深合并
- **不走运行时代理（Zero Runtime Proxy）**：零中间层、零网络延迟、原生维持各大 Agent 的思考流解析。
- **全量多模型常驻（Additive Multi-Provider Catalog）**：将一份总谱编译分发到所有 Agent 的原生配置中，每个 Agent 内部都包含全量模型库，会话内敲 `/model` 自由切，多工作区多开并发互不打扰。
- **安全深度合并（Safe Deep Merge）**：只管理各 Agent 的模型/供应商节点，100% 保护用户的 UI 主题、快捷键、自定义 MCP Server 及 Subagent 规则，写入前强制做原子备份。

---

## 2. 产品定位与品牌传播 (Brand & Virality)

### 2.1 命名与概念隐喻
- **名称**: `Unisono`（音乐术语：齐奏 / 齐鸣；CLI 短别名：`unis`）。
- **隐喻 (Metaphor)**:
  - **总谱 (The Score)**：`~/.config/unisono.yaml` 是唯一真实源；
  - **指挥棒 (The Baton)**：`unis sync` 敲下，各声部瞬间步调一致；
  - **各声部 (The Orchestra)**：Pi（弦乐）、OMP（木管）、OpenCode（铜管）、Hermes（打击乐）、OpenClaw（键盘）。
- **用户情绪价值 (Delight & Relief)**:
  - 终结多配置文件手工同步的焦虑；
  - 带来“一键令下，各路 Agent 严丝合缝、齐刷刷对齐”的极度掌控感与秩序感。
- **生态排查保证**:
  - npm Registry 官方状态：`unisono` 404 Not Found（100% 未被注册）；
  - GitHub Index：全网无同名 AI/CLI 活跃项目。

---

## 3. 产品形态与演进路线 (Product Form & Roadmap)

采用 **CLI 为基石，Local Web UI 为增强（CLI-Core + Local Web UI）** 的分阶段架构，拒绝笨重、难以维护的桌面安装包（Tauri/Electron）：

```text
┌─────────────────────────────────────────────────────────────┐
│ Phase 1: 核心编译器与 CLI 引擎 (CLI-First)                  │
│ 目标：打通单一总谱到 5 大开源 Agent 的编译、深合并与回滚机制    │
├─────────────────────────────────────────────────────────────┤
│ 1. Canonical Schema 定义 (unisono.yaml)                      │
│ 2. 5 个首发 Adapter (Pi, OMP, OpenCode, Hermes, OpenClaw)    │
│ 3. 写入前原子快照引擎 (~/.config/unisono/backups/)            │
│ 4. 核心 CLI 命令: `unis sync` / `diff` / `validate` / `rollback` │
└──────────────────────────────┬──────────────────────────────┘
                               │
                               ▼
┌─────────────────────────────────────────────────────────────┐
│ Phase 2: 本地轻量可视化面板 (`unis ui`)                     │
│ 目标：提供极致直观的“一键同频”视觉爽感与模型矩阵总览           │
├─────────────────────────────────────────────────────────────┤
│ 1. `unis ui` 本地轻量 Web 服务 (基于 Bun.serve 零依赖启动)   │
│ 2. 乐团总览面板 (Scoreboard): 自动探测已安装 Agent 与同步状态 │
│ 3. 模型矩阵大屏 (Matrix Table): 各模型在各端的上下文限制对照  │
│ 4. 可视化差异对比器 (Diff Inspector) 与一键 "Sync All" 按钮    │
└──────────────────────────────┬──────────────────────────────┘
                               │
                               ▼
┌─────────────────────────────────────────────────────────────┐
│ Phase 3: 生态扩充与工具链集成                               │
│ 目标：覆盖更多主流 Agent，提供连通性测速与全局触达           │
├─────────────────────────────────────────────────────────────┤
│ 1. 扩充 Adapter (Continue, Aider, Crush, Codex CLI)          │
│ 2. API 连通性与网络延迟探测 (Ping / Latency Check)           │
│ 3. Raycast Extension / macOS 快捷指令轻量调用                │
└─────────────────────────────────────────────────────────────┘
```

---

## 4. 统一数据契约：总谱规范 (Canonical Score Schema)

用户仅需维护单一文件 `~/.config/unisono.yaml`。规范设计要求：**兼顾人类手写易读性、严格的环境变量安全性、以及完整的模型元数据保留**。

```yaml
# ~/.config/unisono.yaml
version: "1"

# 目标 Agent 自定义覆盖（可选，默认自动探测标准路径）
targets:
  pi:
    enabled: true
    path: "~/.pi/agent/models.json"
  omp:
    enabled: true
    path: "~/.omp/agent/models.yml"
  opencode:
    enabled: true
    path: "~/.config/opencode/opencode.json"
  hermes:
    enabled: true
    path: "~/.hermes/config.yaml"
  openclaw:
    enabled: true
    path: "~/.openclaw/openclaw.json"

# 供应商与模型矩阵定义
providers:
  deepseek:
    name: "DeepSeek Official"
    baseUrl: "https://api.deepseek.com/v1"
    apiKey: "${DEEPSEEK_API_KEY}" # 支持 ${ENV_VAR} 格式，避免明文泄露
    apiType: "openai-completions" # openai-completions | openai-responses | anthropic-messages
    headers:
      "User-Agent": "Unisono-Sync/1.0"
    models:
      - id: "deepseek-chat"
        name: "DeepSeek V3"
        contextWindow: 65536
        maxTokens: 8192
        reasoning: false
      - id: "deepseek-reasoner"
        name: "DeepSeek R1 (Reasoning)"
        contextWindow: 65536
        maxTokens: 8192
        reasoning: true # 标记具备思维链/思考能力

  kimi:
    name: "Moonshot Kimi"
    baseUrl: "https://api.moonshot.cn/v1"
    apiKey: "${KIMI_API_KEY}"
    apiType: "openai-completions"
    models:
      - id: "kimi-k2.5"
        name: "Kimi K2.5 (256K Thinking)"
        contextWindow: 262144
        maxTokens: 8192
        reasoning: true

  zhipu:
    name: "Zhipu BigModel"
    baseUrl: "https://open.bigmodel.cn/api/coding/paas/v4"
    apiKey: "${ZHIPU_API_KEY}"
    apiType: "openai-completions"
    models:
      - id: "glm-4-flash"
        name: "GLM-4 Flash (Ultra Fast)"
        contextWindow: 131072
        maxTokens: 4096
        reasoning: false
```

---

## 5. Phase 1 各声部 Adapter 编译与映射契约

所有 Adapter 必须继承统一抽象 `BaseAgentAdapter`：

```typescript
export interface AgentAdapter {
  readonly id: string;
  readonly name: string;
  readonly defaultPath: string;
  isDetected(): Promise<boolean>;
  readExisting(): Promise<Record<string, unknown> | null>;
  compile(score: CanonicalScore, existing: Record<string, unknown> | null): Record<string, unknown> | string;
  write(content: Record<string, unknown> | string): Promise<void>;
}
```

### 5.1 Pi 适配器 (`PiAdapter`)
- **配置文件路径**: `~/.pi/agent/models.json` (JSON)
- **挂载根节点**: `providers.<provider_id>`
- **合并策略**: 保持现有 `defaultProvider`、`defaultModel` 及未管理 provider；仅对总谱中声明的 provider 执行 upsert。
- **模型条目映射**:
  ```json
  {
    "id": "deepseek-reasoner",
    "name": "DeepSeek R1 (Reasoning)",
    "contextWindow": 65536,
    "maxTokens": 8192,
    "reasoning": true
  }
  ```

### 5.2 OMP 适配器 (`OmpAdapter`)
- **配置文件路径**: `~/.omp/agent/models.yml` (YAML)
- **挂载根节点**: `providers.<provider_id>`
- **合并策略**: 保留非模型段落（如 `modelRoles`、快捷命令别名）；将总谱中的每个 provider 转换为标准的 YAML 节点。
- **模型条目映射**:
  ```yaml
  providers:
    deepseek:
      baseUrl: "https://api.deepseek.com/v1"
      api: "openai-completions"
      apiKey: "sk-..."
      models:
        - id: "deepseek-reasoner"
          name: "DeepSeek R1 (Reasoning)"
          contextWindow: 65536
          maxTokens: 8192
          reasoning: true
  ```

### 5.3 OpenCode 适配器 (`OpenCodeAdapter`)
- **配置文件路径**: `~/.config/opencode/opencode.json` (JSON)
- **挂载根节点**: `provider.<provider_id>`
- **合并策略**: 保留用户的 `theme`、`keybinds`、`mcp` 配置；对 `provider` 字典执行合并。
- **SDK 包名契约**: 固定注入 `"npm": "@ai-sdk/openai-compatible"`。
- **模型限制映射**:
  ```json
  {
    "provider": {
      "deepseek": {
        "npm": "@ai-sdk/openai-compatible",
        "name": "DeepSeek Official",
        "options": {
          "baseURL": "https://api.deepseek.com/v1",
          "apiKey": "sk-..."
        },
        "models": {
          "deepseek-reasoner": {
            "name": "DeepSeek R1 (Reasoning)",
            "limit": {
              "context": 65536,
              "output": 8192
            }
          }
        }
      }
    }
  }
  ```

### 5.4 Hermes 适配器 (`HermesAdapter`)
- **配置文件路径**: `~/.hermes/config.yaml`（或通过 `HERMES_HOME` 环境变量获取）
- **挂载根节点**: `custom_providers[]` 数组
- **合并策略**: 保留已有的 `model.default`、`agent.max_turns`、`mcp_servers` 等系统配置；对 `custom_providers` 数组进行 keyed upsert（按 `name` 字段对齐）。
- **模型参数映射**:
  ```yaml
  custom_providers:
    - name: "deepseek"
      base_url: "https://api.deepseek.com/v1"
      api_key: "sk-..."
      models:
        deepseek-reasoner:
          context_length: 65536
          reasoning_effort: "high"
  ```

### 5.5 OpenClaw 适配器 (`OpenClawAdapter`)
- **配置文件路径**: `~/.openclaw/openclaw.json` (JSON5)
- **挂载根节点**: `models.providers.<provider_id>`
- **合并策略**: 保持 `models.mode = 'merge'`，在 `providers` 下追加或更新总谱供应商；保留用户的 tools profiles 与认证元数据。
- **模型条目映射**:
  ```json
  {
    "models": {
      "mode": "merge",
      "providers": {
        "deepseek": {
          "baseUrl": "https://api.deepseek.com/v1",
          "apiKey": "sk-...",
          "models": [
            {
              "id": "deepseek-reasoner",
              "name": "DeepSeek R1 (Reasoning)",
              "contextWindow": 65536,
              "maxTokens": 8192
            }
          ]
        }
      }
    }
  }
  ```

---

## 6. CLI 命令行设计与人机交互 (CLI Specification)

二进制别名统一注册为 `unis`（推荐高频使用）与 `unisono`（全名）：

```bash
# 1. 核心同步命令
unis sync                       # 自动探测已安装 Agent 并全量同步
unis sync --only pi,omp         # 仅同步指定 Agent
unis sync --dry-run             # 仅预览变更差异（Diff），不写入磁盘
unis sync --score ./custom.yaml # 指定自定义总谱文件路径

# 2. 差异对比与状态检查
unis diff                       # 对比当前总谱与各 Agent 实际配置文件的差异
unis validate                   # 校验总谱 YAML 语法、字段有效性及环境变量是否存在
unis list                       # 罗列当前系统探测到的 Agent、配置路径及同步状态

# 3. 灾难恢复与回滚
unis rollback                   # 回滚到上一次同步前的备份状态
unis rollback --list            # 查看所有历史备份时间戳
unis rollback <timestamp>       # 回滚到指定的历史快照
```

### 终端输出体验标准 (CLI UX Standards)
- 使用现代化终端着色（绿色代表 Synced，黄色代表 Diff/Warning，红色代表 Missing/Error）；
- 每次 `unis sync` 耗时要求 $\le 100\text{ms}$，在终端输出整齐的声部对齐结果：
  ```text
  🎼 Unisono v1.0.0 — One score. All agents in unison.

  ✓ [Score] ~/.config/unisono.yaml (3 providers, 6 models)
  ✓ [Pi]       ~/.pi/agent/models.json          -> Synced (+2 providers, updated)
  ✓ [OMP]      ~/.omp/agent/models.yml          -> Synced (+2 providers, updated)
  ✓ [OpenCode] ~/.config/opencode/opencode.json -> Synced (+2 providers, updated)
  - [Hermes]   ~/.hermes/config.yaml            -> Skipped (not installed)
  ✓ [OpenClaw] ~/.openclaw/openclaw.json        -> Synced (+2 providers, updated)

  Backup saved: ~/.config/unisono/backups/2026-09-10T16-30-00Z/
  ✨ All agents in unison! (42ms)
  ```

---

## 7. 容错性、安全性与数据完整性保障 (Safety & Resilience)

1. **零丢配置底线（Non-Destructive Deep Merge）**：
   - 严禁全文件覆盖。
   - 必须先读取目标现有配置，只针对模型/Provider 对应树节点进行 Patch 写入，其他未受管字段原样保留。
2. **写前自动原子备份（Pre-write Atomic Snapshot）**：
   - 在向任何 Agent 配置文件发起写入前的毫秒级时间内，将目标现有文件复制到 `~/.config/unisono/backups/{ISO_TIMESTAMP}/{agent_name}.ext`；
   - 保留最近 10 次历史备份，防止磁盘空间过度消耗。
3. **敏感凭证防泄漏（Environment Variable Sanitization）**：
   - 推荐在 `unisono.yaml` 中使用 `${VAR_NAME}` 语法；
   - `unis validate` 会检查对应环境变量是否在当前 Shell 中已导出（Exported）；
   - 在 `unis diff` 或 UI 输出时，自动将 Key 脱敏（如 `sk-ab***12cd`）。

---

## 8. 工程目录架构规划 (Repository Scaffold - Bun)

```text
unisono/
├── package.json               # bin: { "unis": "./src/cli.ts", "unisono": "./src/cli.ts" }
├── bun.lock
├── tsconfig.json
├── README.md
├── src/
│   ├── cli.ts                 # CLI 命令解析与终端彩色输出格式化
│   ├── types.ts               # Canonical 核心类型与 Zod/Type 校验
│   ├── parser.ts              # YAML 读取、语法校验与 ${ENV} 变量展开器
│   ├── merger.ts              # 深合并工具函数与原子写安全引擎
│   ├── backup.ts              # 历史快照创建与 rollback 恢复管理器
│   └── adapters/              # 各声部适配器
│       ├── base.ts            # AgentAdapter 抽象基类
│       ├── pi.ts              # Pi 适配器
│       ├── omp.ts             # OMP 适配器
│       ├── opencode.ts        # OpenCode 适配器
│       ├── hermes.ts          # Hermes 适配器
│       └── openclaw.ts        # OpenClaw 适配器
├── test/                      # 单元测试与端到端模拟测试
│   ├── fixtures/              # 各 Agent 真实配置 Mock 样本
│   │   ├── pi-models.json
│   │   ├── omp-models.yml
│   │   ├── opencode.json
│   │   ├── hermes.yaml
│   │   └── openclaw.json
│   ├── parser.test.ts         # 环境变量展开与 YAML 校验单测
│   ├── merger.test.ts         # 非破坏性深合并单测（验证保留 theme/mcp）
│   └── adapters.test.ts       # 5 大 Adapter 编译输出确定性单测
```

---

## 9. Phase 1 开发实施计划 (Implementation Checklist)

- [ ] **Step 1: 脚手架与核心类型初始化**
  - 初始化 Bun 项目，配置 TypeScript 与轻量 YAML 解析依赖（`yaml` 库）；
  - 在 `src/types.ts` 中固化 `CanonicalScore`, `CanonicalProvider`, `CanonicalModel` 契约。
- [ ] **Step 2: 编写总谱解析器 (`src/parser.ts`)**
  - 实现 YAML 解析，支持 `${VAR_NAME}` 正则替换；
  - 编写单测覆盖变量存在、缺失警告及默认值场景。
- [ ] **Step 3: 编写备份管理器与深合并引擎 (`src/backup.ts`, `src/merger.ts`)**
  - 实现写前快照、历史轮转（保留 10 份）与一键还原；
  - 编写深度合并算法，确保 Object/Array 按照 Agent 规则增量更新。
- [ ] **Step 4: 实现 5 大核心声部 Adapter (`src/adapters/*`)**
  - 分别编写 `Pi`, `OMP`, `OpenCode`, `Hermes`, `OpenClaw` 适配逻辑；
  - 为每个 Adapter 编写对应的单测，比对输出结构。
- [ ] **Step 5: 组装 CLI 入口 (`src/cli.ts`)**
  - 实现 `sync`, `diff`, `validate`, `rollback`, `list` 命令与 Terminal 优雅输出。
- [ ] **Step 6: 端到端集成验证与交付**
  - 运行 `bun test` 达成 100% 测试通过率；
  - 本地验证多工作区多开并发场景下模型配置的一致性。
