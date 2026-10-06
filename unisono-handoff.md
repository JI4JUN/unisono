# Unisono (`unis`) - 产品需求文档 (PRD) & 架构工程交接

> **Slogan**: *"One score. All agents in unison."* (一份总谱，万部和鸣)  
> **项目定位**: 声明式多 Agent 模型目录编译器（Declarative Multi-Agent Model Catalog Compiler）  
> **CLI 别名**: `unis` / `unisono`  
> **当前状态**: 已立项 / 方案终审通过 / 进入 Phase 1 工程研发  
> **核心运行环境**: **Bun ONLY** (`bun run`, `bun test`, 纯 CLI，零常驻 Daemon，零桌面端/Web 包袱)  
> **领域术语与架构决策**: 见 [`GLOSSARY.md`](./GLOSSARY.md) 与 [`docs/adr/0001-takeover-instead-of-merge.md`](./docs/adr/0001-takeover-instead-of-merge.md)

---

## 1. 业务背景与问题定义 (Context & Problem)

### 1.1 现状与痛点
在当前的 AI 编程生态中，开源终端 Agent（`pi`, `omp`, `opencode`, `hermes`, `openclaw`）均原生支持多供应商共存（Coexist Mode）。然而，重度多 Agent 开发者仍面临三大痛点：

1. **网关黑盒削足适履（Gateway Latency & Context Degradation）**：
   - 依赖集中式运行时网关（如 LiteLLM、Bifrost）只暴露单一端点，容易掩盖各模型的物理上限与协议差异。
   - Coding Agent 严重依赖准确的本地模型元数据：上下文窗口（`contextWindow`）直接决定 AST 局部剪枝、代码搜索预算和 `auto-compact` 压缩时机；
   - 思考能力（`reasoning`、`thinking`、`compat` 兼容标志）在不同模型与端点间差异极大，网关抹平这些参数会导致 Agent 频繁 400 报错或过早压缩丢失长程记忆。
2. **现有 GUI 切换器缺乏“共存型 Agent 跨端单一真实源”**：
   - 以 `CC Switch` 为代表的 Tauri 桌面工具虽已支持向 `pi`、`opencode`、`hermes`、`openclaw` 逐个添加供应商，但其跨端同步机制（`Universal Provider`）**仅支持 Claude Code / Codex / Gemini 三个单选型工具**；
   - 在上述共存型 Agent 中，用户仍需在每个 App 标签页下分别维护供应商卡片与预设副本，无法做到一处声明（含模型级 `contextWindow`、`compat`、`thinking` 元数据）五端同步；
   - 此外，`CC Switch` 对 `omp`（Oh My Pi）的支持（PR `#6747`）仍处于未合并的 Draft 阶段，且基于本地 SQLite 的 GUI 形态无法纳入 Git / dotfiles 进行声明式版本控制或在无头（SSH / 容器）环境运行。
3. **多端异构配置割裂与维护负担**：
   - 五个 Agent 的配置路径、格式与字段命名各不相同：
     - `omp`: `~/.omp/agent/models.yml` (YAML，`providers.<id>.models[]`)
     - `pi`: `~/.pi/agent/models.json` (JSON，`providers.<id>.models[]`)
     - `opencode`: `~/.config/opencode/opencode.json[c]` (JSON/JSONC，`provider.<id>.models.<model_id>`)
     - `hermes`: `~/.hermes/config.yaml` (YAML，`providers.<id>.models.<model_id>` 及旧版 `custom_providers[]`)
     - `openclaw`: `~/.openclaw/openclaw.json` (JSON5，`models.providers.<id>.models[]`)
   - 轮换一次 API Key、新增一个中转商或调整某模型的 `contextWindow`，必须手工同步改写 5 份异构文件。

### 1.2 核心破局思路：单一总谱编译与 Catalog 全权接管
- **零运行时代理（Zero Runtime Proxy）**：零中间层、零网络延迟，直接编译生成各 Agent 的原生配置文件。
- **全量多模型常驻（Additive Multi-Provider Catalog）**：将单一总谱（Score，`~/.config/unisono/score.yaml`）编译分发到所有已启用 Agent 的模型目录（Catalog）中，各 Agent 内部均拥有完整候选列表，会话内 `/model` 自由切换（注：修改配置后对新开会话或支持 `/reload` 的会话生效）。
- **Catalog 全权接管 + 非 Catalog 节点 100% 保留（Catalog Takeover）**：
  - 详见 [ADR 0001](./docs/adr/0001-takeover-instead-of-merge.md)。`unis sync` 对每个 Agent 的 **Catalog 子树**执行整块替换（Score 是 Catalog 的唯一真实源，不在 Score 中的供应商/模型将被移除）；
  - 各 Agent 的特有字段（如 `omp` 的 `compat`/`thinking`/`cost`）统一通过 Score 内的 `overrides.<agent>` 就近声明并在编译期深合并；
  - Catalog 之外的所有节点（UI 主题、快捷键、MCP Servers、`modelRoles`、默认模型设置等）100% 原样保留。

---

## 2. 概念模型与品牌命名 (Domain Language & Brand)

统一使用 [`GLOSSARY.md`](./GLOSSARY.md) 中定义的规范术语，代码中严禁混用近义词：

- **Score（总谱）**：用户唯一维护的声明式 YAML 文件（`$XDG_CONFIG_HOME/unisono/score.yaml`，默认 `~/.config/unisono/score.yaml`）。避免在代码中称作 `config` 或 `manifest`。
- **Agent**：被 Unisono 写入原生配置的第三方编码工具（`omp`, `pi`, `opencode`, `hermes`, `openclaw`）。避免称作 `target` 或 `client`。
- **Provider（供应商）**：Score 中声明的 API 端点、凭证与模型集合。
- **Model（模型）**：Provider 下的单个模型条目及其能力元数据。
- **Catalog（模型目录）**：Agent 原生配置文件中承载 Provider 与 Model 列表的特定子树；除 Catalog 外的其余配置完全归用户所有。
- **Takeover（接管）**：Unisono 对 Catalog 子树的独占管理策略——每次 `sync` 后，Catalog 的内容精确等于 Score（含 Override）的编译结果。
- **Override（专属覆盖）**：在 Score 的 Provider 或 Model 下按 `overrides.<agent>` 编写的某 Agent 原生专有字段，用于表达通用字段之外的高级参数。
- **Sync（同步）**：编译 Score 并写入各 Agent Catalog 的过程。

---

## 3. 产品形态与演进路线 (Product Form & Roadmap)

坚持 **纯 CLI-First** 路线，不引入 Tauri/Electron 桌面客户端，也不维护本地 Web UI 服务（遵循 YAGNI），推进策略采用**纵向切片先行**：

```text
┌───────────────────────────────────────────────────────────────────┐
│ Phase 1A: 核心引擎与 OMP 纵向闭环 (Tracer Bullet)                 │
│ 目标：在本机有真实复杂样本的 OMP 上跑通完整编译、接管保护与回滚闭环 │
├───────────────────────────────────────────────────────────────────┤
│ 1. Score Schema 校验与环境变量展开器 (`~/.config/unisono/score.yaml`) │
│ 2. 备份快照引擎 (`~/.config/unisono/backups/`) 与权限保护 (0600)    │
│ 3. OMP Adapter (`~/.omp/agent/models.yml`) 整块接管与 Override 合并 │
│ 4. `unis import omp`（从现有配置反向生成含 overrides 的 Score 草稿） │
│ 5. 核心 CLI: `unis sync [--yes]` / `diff` / `validate` / `rollback` │
└─────────────────────────────────┬─────────────────────────────────┘
                                  │
                                  ▼
┌───────────────────────────────────────────────────────────────────┐
│ Phase 1B: 平行铺开其余 4 大共存型 Agent Adapter                     │
│ 目标：基于已验证的权威 Schema 完成五端同步与悬空引用只读告警        │
├───────────────────────────────────────────────────────────────────┤
│ 1. `PiAdapter`       (~/.pi/agent/models.json)                    │
│ 2. `OpenCodeAdapter` (~/.config/opencode/opencode.json[c])        │
│ 3. `HermesAdapter`   (~/.hermes/config.yaml, v12+ `providers`)    │
│ 4. `OpenClawAdapter` (~/.openclaw/openclaw.json, JSON5)           │
│ 5. 跨文件默认模型悬空引用检查器（仅告警，绝不篡改用户默认模型）     │
└─────────────────────────────────┬─────────────────────────────────┘
                                  │
                                  ▼
┌───────────────────────────────────────────────────────────────────┐
│ Phase 2: 生态扩展与端点诊断                                       │
│ 目标：覆盖更多工具，提供端点连通性与模型列表探测                   │
├───────────────────────────────────────────────────────────────────┤
│ 1. 扩展 Adapter (Continue, Aider, Crush, Codex CLI)               │
│ 2. `unis ping` 端点连通性、延迟探测与 `/v1/models` 校验            │
└───────────────────────────────────────────────────────────────────┘
```

---

## 4. 统一数据契约：总谱规范 (Canonical Score Schema)

用户仅需维护 `$XDG_CONFIG_HOME/unisono/score.yaml`（未设置 `XDG_CONFIG_HOME` 时为 `~/.config/unisono/score.yaml`）。

```yaml
# ~/.config/unisono/score.yaml
version: "1"

# 可选：自定义各 Agent 启用状态与配置文件路径（默认自动按各 Agent 官方规则探测）
agents:
  omp:
    enabled: true
    path: "~/.omp/agent/models.yml"
  pi:
    enabled: true
    path: "~/.pi/agent/models.json"
  opencode:
    enabled: true
    path: "~/.config/opencode/opencode.json"
  hermes:
    enabled: true
    path: "~/.hermes/config.yaml"
  openclaw:
    enabled: true
    path: "~/.openclaw/openclaw.json"

# 供应商与模型矩阵定义（以下示例共 3 providers, 4 models）
providers:
  deepseek:
    name: "DeepSeek Official"
    baseUrl: "https://api.deepseek.com/v1"
    apiKey: "${DEEPSEEK_API_KEY}"          # 编译时展开为明文写入目标配置；缺失或为空时报错中止
    apiType: "openai-completions"          # openai-completions | openai-responses | anthropic-messages
    headers:
      "User-Agent": "Unisono-Sync/1.0"
    overrides:
      omp:
        compat:
          supportsDeveloperRole: false
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
        reasoning: true
        overrides:
          omp:
            input: ["text"]
            cost: { input: 0.55, output: 2.19, cacheRead: 0.14, cacheWrite: 0 }
            thinking:
              mode: "effort"
              efforts: ["low", "medium", "high"]
              effortMap: { low: "low", medium: "medium", high: "high" }
            compat:
              reasoningContentField: "reasoning_content"
              requiresReasoningContentForToolCalls: true

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

### Override 合并规则
- `providers.<id>.overrides.<agent>` 与 `models[].overrides.<agent>` 接收对应 Agent 的原生配置片段（Object）。
- 编译某 Agent 时，先生成标准字段映射结果，再将该 Agent 的 `overrides.<agent>` 深度合并（Deep Merge）到该 Provider 或 Model 节点上，**Override 同名键优先**。

---

## 5. 各 Agent Adapter 权威 Schema 与编译契约

所有 Adapter 实现统一接口 `AgentAdapter`：

```typescript
export type AgentId = "omp" | "pi" | "opencode" | "hermes" | "openclaw";

export interface AgentAdapter {
  readonly id: AgentId;
  readonly name: string;
  resolvePath(customPath?: string): string;
  isDetected(customPath?: string): Promise<boolean>;
  readExisting(filePath: string): Promise<{ raw: string; data: Record<string, unknown> } | null>;
  extractCatalogProviderIds(existing: Record<string, unknown> | null): string[];
  isCatalogEqual(existing: Record<string, unknown> | null, compiled: Record<string, unknown>): boolean;
  compile(score: CanonicalScore, existing: Record<string, unknown> | null): Record<string, unknown>;
  serialize(compiled: Record<string, unknown>): string;
  checkDanglingReferences(score: CanonicalScore, configPath: string): Promise<string[]>;
}
```

### 5.1 OMP 适配器 (`OmpAdapter`)
- **默认路径探测**: 若设置了 `OMP_CODING_AGENT_DIR` 则取 `$OMP_CODING_AGENT_DIR/models.yml`，否则取 `~/.omp/agent/models.yml`（若仅存在 `models.yaml` 则读写该文件）。
- **格式**: YAML。
- **接管边界 (Catalog Key)**: 顶层 `providers` 字典整块替换；保留顶层其他键（如 `modelOverrides`）。
- **悬空引用检查**: 读取同目录 `config.yml` 中的 `modelRoles`（格式 `<provider>/<model>[:thinking]`）与 `enabledModels`；若引用了旧 Catalog 中存在但本次被删的 provider/model，返回告警。
- **编译输出示例**:
  ```yaml
  providers:
    deepseek:
      baseUrl: "https://api.deepseek.com/v1"
      api: "openai-completions"
      apiKey: "sk-expanded-plaintext..."
      headers:
        User-Agent: "Unisono-Sync/1.0"
      compat:
        supportsDeveloperRole: false
      models:
        - id: "deepseek-reasoner"
          name: "DeepSeek R1 (Reasoning)"
          contextWindow: 65536
          maxTokens: 8192
          reasoning: true
          input: ["text"]
          cost: { input: 0.55, output: 2.19, cacheRead: 0.14, cacheWrite: 0 }
          thinking:
            mode: "effort"
            efforts: ["low", "medium", "high"]
            effortMap: { low: "low", medium: "medium", high: "high" }
          compat:
            reasoningContentField: "reasoning_content"
            requiresReasoningContentForToolCalls: true
  ```

### 5.2 Pi 适配器 (`PiAdapter`)
- **默认路径探测**: `${PI_CODING_AGENT_DIR:-~/.pi/agent}/models.json`。
- **格式**: JSON（Pi 读取时支持剥离 `//` 行注释与尾逗号，写回时输出 2 空格缩进标准 JSON）。
- **接管边界 (Catalog Key)**: 顶层 `providers` 字典整块替换；保留顶层其他键。
- **特殊转义约束**: Pi 的 `resolveConfigValue` 会将 `!` 开头的字符串当作 Shell 命令执行，将 `$VAR` 当作环境变量展开。因此写入明文 `apiKey` 和 `headers` 值时，若以 `!` 开头必须转义为 `$!`，若包含 `$` 必须转义为 `$$`。
- **悬空引用检查**: 读取同目录 `settings.json` 的 `defaultProvider` / `defaultModel` 进行只读校验。
- **编译输出示例**:
  ```json
  {
    "providers": {
      "deepseek": {
        "name": "DeepSeek Official",
        "baseUrl": "https://api.deepseek.com/v1",
        "api": "openai-completions",
        "apiKey": "sk-expanded-plaintext...",
        "headers": {
          "User-Agent": "Unisono-Sync/1.0"
        },
        "models": [
          {
            "id": "deepseek-reasoner",
            "name": "DeepSeek R1 (Reasoning)",
            "contextWindow": 65536,
            "maxTokens": 8192,
            "reasoning": true
          }
        ]
      }
    }
  }
  ```

### 5.3 OpenCode 适配器 (`OpenCodeAdapter`)
- **默认路径探测**: 按 OpenCode 官方优先级探测 `${OPENCODE_CONFIG}`，或在 `${OPENCODE_CONFIG_DIR:-~/.config/opencode}` 下按顺序查找已存在的 `opencode.jsonc`、`opencode.json`、`config.json`（均不存在时默认创建 `opencode.json`）。
- **格式**: JSON / JSONC（使用 `Bun.JSONC.parse` 解析现有文件，写回标准 2 空格 JSON；若原文件无 `$schema` 则补齐 `"$schema": "https://opencode.ai/config.json"`）。
- **接管边界 (Catalog Key)**: 顶层 `provider`（单数）字典整块替换；保留 `theme`、`keybinds`、`mcp`、`model`、`small_model`、`enabled_providers`、`disabled_providers` 等所有其他顶层键。
- **`apiType` 到 `npm` 包名映射**:
  - `openai-completions` $\rightarrow$ `"@ai-sdk/openai-compatible"`
  - `openai-responses` $\rightarrow$ `"@ai-sdk/openai"`
  - `anthropic-messages` $\rightarrow$ `"@ai-sdk/anthropic"`
- **悬空引用检查**: 检查同文件顶层 `model` 与 `small_model`（格式 `<provider>/<model>`）。
- **编译输出示例**:
  ```json
  {
    "$schema": "https://opencode.ai/config.json",
    "provider": {
      "deepseek": {
        "npm": "@ai-sdk/openai-compatible",
        "name": "DeepSeek Official",
        "options": {
          "baseURL": "https://api.deepseek.com/v1",
          "apiKey": "sk-expanded-plaintext...",
          "headers": {
            "User-Agent": "Unisono-Sync/1.0"
          }
        },
        "models": {
          "deepseek-reasoner": {
            "name": "DeepSeek R1 (Reasoning)",
            "reasoning": true,
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
- **默认路径探测**: `${HERMES_HOME:-~/.hermes}/config.yaml`。
- **格式**: YAML（注意：若原文件因历史工具 bug 存在重复顶层键，解析前执行 keep-last 去重）。
- **接管边界 (Catalog Key)**:
  - Hermes 自 `_config_version: 12` 起已将旧版 `custom_providers` 数组迁移为顶层 `providers` 字典，且运行时 `get_compatible_custom_providers()` 会同时读取 `providers` 与遗留的 `custom_providers`。
  - 因此 `HermesAdapter` **统一写入 v12+ 标准 `providers` 字典，并在写回时移除顶层遗留的 `custom_providers` 键**（`extractCatalogProviderIds` 同时扫描 `providers` 与 `custom_providers` 以触发首次接管保护）。
  - 100% 保留 `model`、`agent`、`mcp_servers`、`toolsets`、`_config_version` 等其余顶层节点。
- **`apiType` 到 `transport` 映射**:
  - `openai-completions` $\rightarrow$ `"chat_completions"`
  - `openai-responses` $\rightarrow$ `"codex_responses"`
  - `anthropic-messages` $\rightarrow$ `"anthropic_messages"`
- **字段映射说明**:
  - `baseUrl` 映射为 `api`；`headers` 映射为 `extra_headers`；`default_model` 取该 Provider 下第一个 Model 的 `id`。
  - Hermes 的 `models.<model_id>` 原生仅消费 `context_length`（无 per-model `maxTokens` 或布尔 `reasoning` 字段；如需设置其他属性可通过 `overrides.hermes` 注入）。
- **悬空引用检查**: 检查顶层 `model.provider` / `model.default` / `model.base_url`。
- **编译输出示例**:
  ```yaml
  providers:
    deepseek:
      name: "DeepSeek Official"
      api: "https://api.deepseek.com/v1"
      api_key: "sk-expanded-plaintext..."
      transport: "chat_completions"
      default_model: "deepseek-chat"
      extra_headers:
        User-Agent: "Unisono-Sync/1.0"
      models:
        deepseek-chat:
          context_length: 65536
        deepseek-reasoner:
          context_length: 65536
  ```

### 5.5 OpenClaw 适配器 (`OpenClawAdapter`)
- **默认路径探测**: `${OPENCLAW_AGENT_DIR:-~/.openclaw}/openclaw.json`。
- **格式**: JSON5（使用 `Bun.JSON5.parse` 读取，输出标准 2 空格 JSON——合法 JSON5 子集）。
- **接管边界 (Catalog Key)**: 替换 `models.providers` 字典（若 `models.mode` 未设置则置为 `"merge"`）；保留 `models` 下其他键及顶层 `agents`、`tools`、`env`、`plugins` 等全部配置。
- **悬空引用检查**: 检查 `agents.defaults.model.primary` 与 `agents.defaults.model.fallbacks`。
- **编译输出示例**:
  ```json
  {
    "models": {
      "mode": "merge",
      "providers": {
        "deepseek": {
          "baseUrl": "https://api.deepseek.com/v1",
          "apiKey": "sk-expanded-plaintext...",
          "api": "openai-completions",
          "headers": {
            "User-Agent": "Unisono-Sync/1.0"
          },
          "models": [
            {
              "id": "deepseek-reasoner",
              "name": "DeepSeek R1 (Reasoning)",
              "contextWindow": 65536,
              "maxTokens": 8192,
              "reasoning": true
            }
          ]
        }
      }
    }
  }
  ```

---

## 6. CLI 命令行设计与人机交互 (CLI Specification)

二进制别名注册为 `unis` 与 `unisono`（入口文件顶部需声明 `#!/usr/bin/env bun`）：

```bash
# 1. 核心同步命令
unis sync                         # 自动探测已安装 Agent 并同步（含首次接管保护检查）
unis sync --yes                   # 确认执行首次接管（当目标 Catalog 存在未在 Score 声明的 provider 时）
unis sync --only omp,pi           # 仅同步指定 Agent
unis sync --dry-run               # 仅预览变更差异（Diff，Key 自动脱敏），不写入磁盘
unis sync --score ./custom.yaml   # 指定自定义总谱文件路径

# 2. 现有配置逆向导入
unis import [agent]               # 从现有 Agent（如 omp）的 Catalog 反向生成初始 score.yaml（含 overrides）

# 3. 差异对比与状态检查
unis diff                         # 对比当前 Score 编译结果与各 Agent 实际 Catalog 的语义差异
unis validate                     # 校验 Score 语法、字段必填项、环境变量是否已导出、以及悬空引用检查
unis list                         # 罗列当前系统探测到的 Agent、配置路径及同步状态

# 4. 灾难恢复与回滚
unis rollback                     # 回滚到上一次同步前的备份快照
unis rollback --list              # 查看所有历史备份时间戳（最多保留最近 10 次）
unis rollback <timestamp>         # 回滚到指定的历史快照
```

### 终端输出体验标准 (CLI UX Standards)
- 每次 `unis sync` 耗时 $\le 100\text{ms}$；若某 Agent 的现有 Catalog 与编译结果深度相等，跳过磁盘写入并标记为 `Unchanged`：
  ```text
  🎼 Unisono v1.0.0 — One score. All agents in unison.

  ✓ [Score]    ~/.config/unisono/score.yaml     (3 providers, 4 models)
  ✓ [OMP]      ~/.omp/agent/models.yml          -> Synced (3 providers, 4 models)
  ✓ [Pi]       ~/.pi/agent/models.json          -> Synced (3 providers, 4 models)
  ✓ [OpenCode] ~/.config/opencode/opencode.json -> Unchanged
  - [Hermes]   ~/.hermes/config.yaml            -> Skipped (not installed)
  ⚠ [OpenClaw] ~/.openclaw/openclaw.json        -> Synced (warning: agents.defaults.model.primary references removed provider 'old-proxy')

  Backup saved: ~/.config/unisono/backups/2026-10-06T12-00-00-000Z/
  ✨ All agents in unison! (38ms)
  ```

---

## 7. 容错性、安全性与数据完整性保障 (Safety & Resilience)

1. **首次接管防误删拦截（First-Takeover Guard）**：
   - 执行 `unis sync` 时，若目标 Agent 的现有 Catalog 中包含**未在 Score 中声明的 Provider ID**，默认拒绝写入并列出将被删除的 Provider 清单，提示用户先运行 `unis import <agent>` 迁移配置，或显式追加 `--yes` 强制接管。
2. **写前原子快照与回滚语义（Pre-write Atomic Snapshot）**：
   - 发起写入前，将本次涉及变更的 Agent 原文件备份至 `$XDG_CONFIG_HOME/unisono/backups/{ISO_TIMESTAMP_SAFE}/{agent_id}.ext`（时间戳中的 `:` 替换为 `-`），同时记录 manifest 标记原本不存在的文件（回滚时若原文件不存在则删除新建文件）。
   - 轮转保留最近 10 次备份。
3. **并发写冲突检测与软链接保护（Optimistic Concurrency & Symlink Safety）**：
   - 读取目标文件时记录原始文本 SHA-256；在通过临时文件 `rename` 原子替换前复核磁盘文件哈希，若期间被 Agent 自身进程修改则立即中止报错。
   - 若目标配置文件是符号链接（dotfiles 常见场景），先通过 `realpath` 解析真实目标路径再在同一目录创建临时文件并原子替换，避免破坏软链接。
4. **明文凭证安全边界（Plaintext Key Hygiene）**：
   - Score 中的 `${ENV_VAR}` 在编译时展开为明文写入目标配置；若引用的环境变量未定义或为空字符串，`unis validate` 与 `unis sync` **必须直接报错中止**，严禁静默写入空 Key。
   - 创建的备份目录权限强制设为 `0700`，备份文件及写出的目标配置文件权限强制设为 `0600`。
   - `unis diff` 与日志输出中，所有 `apiKey` / `api_key` 字段统一脱敏为 `sk-ab***12cd`。
5. **语义幂等与注释说明（Idempotent Write & Comment Caveat）**：
   - 采用不保留注释的序列化方案（Q4:C）。为减少无谓格式扰动，仅当目标文件的 Catalog 子树与编译结果语义不等时才执行备份与磁盘写入。

---

## 8. 工程目录架构规划 (Repository Scaffold - Bun)

利用 Bun 原生内置的 `Bun.YAML`、`Bun.JSONC`、`Bun.JSON5`（必要时辅以轻量 `yaml` 库控制序列化缩进），保持极简零冗余依赖：

```text
unisono/
├── GLOSSARY.md                # 领域统一语言词汇表
├── docs/
│   └── adr/
│       └── 0001-takeover-instead-of-merge.md
├── package.json               # bin: { "unis": "./src/cli.ts", "unisono": "./src/cli.ts" }
├── tsconfig.json
├── README.md
├── unisono-handoff.md
├── src/
│   ├── cli.ts                 # CLI 入口 (#!/usr/bin/env bun) 与命令路由
│   ├── types.ts               # Score / Provider / Model / Override / Adapter 类型定义
│   ├── paths.ts               # XDG 路径解析与各 Agent 默认路径探测
│   ├── parser.ts              # Score YAML 读取、校验与 ${ENV} 严格展开器
│   ├── merger.ts              # Override 深合并、Catalog 深度判等、乐观锁原子写与 0600 权限控制
│   ├── backup.ts              # 写前快照、10 次轮转与 rollback 恢复管理器
│   ├── importer.ts            # `unis import` 从现有 Agent 配置生成初始 Score 草稿
│   └── adapters/
│       ├── base.ts            # AgentAdapter 接口与公共辅助函数
│       ├── omp.ts             # OMP 适配器 (~/.omp/agent/models.yml)
│       ├── pi.ts              # Pi 适配器 (~/.pi/agent/models.json)
│       ├── opencode.ts        # OpenCode 适配器 (~/.config/opencode/opencode.json[c])
│       ├── hermes.ts          # Hermes 适配器 (~/.hermes/config.yaml, v12+ providers)
│       └── openclaw.ts        # OpenClaw 适配器 (~/.openclaw/openclaw.json)
└── test/
    ├── fixtures/              # 脱敏后的真实 Agent 配置样本 (OMP / Hermes 等)
    ├── parser.test.ts         # 环境变量展开与缺失报错单测
    ├── merger.test.ts         # Override 合并、非 Catalog 节点保留与幂等不重写单测
    └── adapters.test.ts       # 5 大 Adapter 编译输出、首次接管拦截、import 与 rollback 单测
```

---

## 9. Phase 1 开发实施计划 (Implementation Checklist)

- [ ] **Step 1 (Phase 1A): 脚手架、类型契约与解析器 (`src/types.ts`, `src/paths.ts`, `src/parser.ts`)**
  - 初始化 Bun + TypeScript 项目；
  - 实现 Score 解析、必填项校验与 `${VAR_NAME}` 严格展开（未导出变量直接报错）。
- [ ] **Step 2 (Phase 1A): 备份、原子写与 OMP 纵向闭环 (`src/backup.ts`, `src/merger.ts`, `src/adapters/omp.ts`, `src/importer.ts`)**
  - 实现 `0700`/`0600` 备份快照、10 次轮转、软链接跟随与乐观锁原子写；
  - 实现 `OmpAdapter`（含 `overrides.omp` 深合并与 `config.yml` `modelRoles` 悬空引用告警）及 `unis import omp`；
  - 使用脱敏后的本机真实 `models.yml` 样本跑通 `import -> validate -> diff -> sync -> rollback` 全链路单测。
- [ ] **Step 3 (Phase 1B): 平行实现其余 4 个 Adapter (`pi`, `opencode`, `hermes`, `openclaw`)**
  - 实现 `PiAdapter`（含 `!`/`$` 转义与 `settings.json` 悬空告警）；
  - 实现 `OpenCodeAdapter`（含 JSONC 解析、`apiType -> npm` 映射与 `model`/`small_model` 悬空告警）；
  - 实现 `HermesAdapter`（写入 v12+ `providers` 字典、清理遗留 `custom_providers`、映射 `transport`）；
  - 实现 `OpenClawAdapter`（JSON5 解析、`models.providers` 接管与 `agents.defaults.model` 悬空告警）。
- [ ] **Step 4: CLI 组装与端到端交付 (`src/cli.ts`)**
  - 组装 `sync [--yes] [--only] [--dry-run]`、`import`、`diff`、`validate`、`list`、`rollback` 命令；
  - 运行 `bun test` 全部通过，验证连续两次 `unis sync` 第二次零写入（`Unchanged`）。
