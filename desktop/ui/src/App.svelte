<script>
  const AGENTS = ["omp", "pi"];

  let data = $state(null);
  let loading = $state(true);
  let error = $state(null);
  let consoleOpen = $state(true);
  let consoleText = $state("");
  let syncing = $state(false);
  let confirmTakeover = $state(false);

  async function api(path, options) {
    const res = await fetch(path, options);
    const body = await res.json().catch(() => null);
    if (!res.ok) throw new Error(body?.error ?? `${res.status}`);
    return body;
  }

  async function refresh() {
    try {
      loading = true;
      data = await api("/api/state");
      error = null;
    } catch (err) {
      error = err.message;
    } finally {
      loading = false;
    }
  }

  refresh();

  function modelAssigned(model, agent) {
    return model.agents === null || model.agents.includes(agent);
  }

  async function toggle(model, providerId, agent) {
    const current = model.agents ?? AGENTS;
    const next = current.includes(agent)
      ? current.filter((a) => a !== agent)
      : [...current, agent];
    // Both checked means no restriction at all — clear the field instead of
    // writing a redundant [omp, pi].
    const agents = next.length === AGENTS.length ? null : next;
    try {
      data = await api("/api/assign", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ providerId, modelId: model.id, agents }),
      });
      error = null;
    } catch (err) {
      error = err.message;
    }
  }

  async function sync(force = false) {
    syncing = true;
    consoleOpen = true;
    try {
      const result = await api("/api/sync", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ force }),
      });
      consoleText = result.output;
      if (result.exitCode === 2 && !force) confirmTakeover = true;
      data = await api("/api/state");
      error = null;
    } catch (err) {
      error = err.message;
      consoleText = `${consoleText}\n⚠ ${err.message}`;
    } finally {
      syncing = false;
    }
  }

  function badgeOf(agent) {
    if (!agent.installed) return ["not-installed", `not installed — ${agent.reason}`];
    return agent.synced ? ["synced", "synced"] : ["drifts", "drifts"];
  }
</script>

<header>
  <div class="brand">
    <span class="logo">🎼</span>
    <div>
      <h1>Unisono</h1>
      <p class="motto">One score. All agents in unison.</p>
    </div>
  </div>
  <div class="actions">
    <code class="score-path" title="Score 单一事实源">{data?.scorePath ?? "…"}</code>
    <button onclick={refresh} disabled={loading}>刷新</button>
    <button class="primary" onclick={() => sync(false)} disabled={syncing}>
      {syncing ? "同步中…" : "同步"}
    </button>
  </div>
</header>

{#if error}
  <div class="banner error">⚠ {error}</div>
{/if}

{#if loading}
  <main class="loading">读取配置…</main>
{:else if data}
  <main>
    <section class="panel score">
      <h2>Score — 总谱</h2>
      <p class="hint">
        勾选模型可分配到的 Agent（勾选状态写入 <code>score.yaml</code> 的
        <code>agents</code> 字段；全选即不限制）
      </p>
      {#if data.score.ok}
        {#each data.score.providers as provider (provider.id)}
          <details open>
            <summary>
              <span class="provider-id">{provider.id}</span>
              <span class="meta">{provider.models.length} models · {provider.apiType}</span>
            </summary>
            <ul class="models">
              {#each provider.models as model (model.id)}
                <li>
                  <div class="model-info">
                    <span class="model-name">{model.name}</span>
                    <span class="meta">
                      {model.id} · ctx {model.contextWindow}
                      {#if model.reasoning} · reasoning{/if}
                    </span>
                  </div>
                  <div class="assign" role="group" aria-label="分配">
                    {#each AGENTS as agent}
                      <label class="check">
                        <input
                          type="checkbox"
                          checked={modelAssigned(model, agent)}
                          onchange={() => toggle(model, provider.id, agent)}
                        />
                        <span class={modelAssigned(model, agent) ? "on" : "off"}>
                          {agent}
                        </span>
                      </label>
                    {/each}
                  </div>
                </li>
              {/each}
            </ul>
          </details>
        {/each}
      {:else}
        <p class="error">Score 无效：{data.score.errors[0]}</p>
      {/if}
    </section>

    {#each AGENTS as agent}
      <section class="panel">
        <h2>
          {agent.toUpperCase()}
          <span class="badge {badgeOf(data.agents[agent])[0]}">
            {badgeOf(data.agents[agent])[1]}
          </span>
        </h2>
        <p class="hint">
          <code>{data.agents[agent].path}</code>
        </p>
        {#if data.agents[agent].installed}
          <ul class="agent-models">
            {#each data.agents[agent].providers as provider (provider.id)}
              <li class="agent-provider">
                <span class="provider-id">{provider.id}</span>
                <span class="chips">
                  {#each provider.models as modelId (modelId)}
                    <span class="chip">{modelId}</span>
                  {/each}
                </span>
              </li>
            {/each}
          </ul>
        {:else}
          <p class="error">未安装（{data.agents[agent].reason}）</p>
        {/if}
      </section>
    {/each}
  </main>

  <section class="console">
    <button class="console-toggle" onclick={() => (consoleOpen = !consoleOpen)}>
      {consoleOpen ? "▾" : "▸"} sync 输出
    </button>
    {#if consoleOpen}
      <pre>{consoleText || "（尚无输出 — 点击右上角「同步」）"}</pre>
    {/if}
  </section>
{/if}

{#if confirmTakeover}
  <div class="modal-backdrop" role="presentation">
    <div class="modal" role="dialog" aria-modal="true">
      <h3>首次接管需要确认</h3>
      <p>
        sync 检测到 Agent 配置中存在 Score 未声明的 Provider，接管将删除它们。
        已生成快照，可随时 <code>unis rollback</code> 恢复。
      </p>
      <div class="modal-actions">
        <button onclick={() => (confirmTakeover = false)}>取消</button>
        <button
          class="primary danger"
          onclick={() => {
            confirmTakeover = false;
            sync(true);
          }}
        >
          确认接管并同步
        </button>
      </div>
    </div>
  </div>
{/if}

<style>
  :root {
    color-scheme: dark;
    --bg: #0e1116;
    --surface: #151a21;
    --border: #262d38;
    --fg: #d7dde5;
    --muted: #8a94a3;
    --accent: #4f8cff;
    --ok: #34c98a;
    --warn: #f0a63c;
    --err: #ef5a5a;
  }
  * {
    box-sizing: border-box;
    margin: 0;
  }
  body {
    background: var(--bg);
    color: var(--fg);
    font-family: ui-sans-serif, system-ui, -apple-system, "PingFang SC",
      "Microsoft YaHei", sans-serif;
    font-size: 14px;
  }
  header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 16px;
    padding: 12px 20px;
    border-bottom: 1px solid var(--border);
    background: var(--surface);
    position: sticky;
    top: 0;
    z-index: 10;
  }
  .brand {
    display: flex;
    align-items: center;
    gap: 10px;
  }
  .logo {
    font-size: 26px;
  }
  h1 {
    font-size: 18px;
    letter-spacing: 0.3px;
  }
  .motto {
    color: var(--muted);
    font-size: 12px;
  }
  .actions {
    display: flex;
    align-items: center;
    gap: 10px;
  }
  .score-path {
    color: var(--muted);
    font-size: 12px;
    background: var(--bg);
    border: 1px solid var(--border);
    border-radius: 6px;
    padding: 5px 8px;
  }
  button {
    background: var(--surface);
    color: var(--fg);
    border: 1px solid var(--border);
    border-radius: 6px;
    padding: 6px 14px;
    font-size: 13px;
    cursor: pointer;
  }
  button:hover {
    border-color: var(--accent);
  }
  button.primary {
    background: var(--accent);
    border-color: var(--accent);
    color: #fff;
    font-weight: 600;
  }
  button.primary.danger {
    background: var(--err);
    border-color: var(--err);
  }
  button:disabled {
    opacity: 0.5;
    cursor: default;
  }
  .banner {
    padding: 8px 20px;
    font-size: 13px;
  }
  .banner.error {
    background: #3a1d1d;
    color: var(--err);
  }
  main {
    display: grid;
    grid-template-columns: 2fr 1fr 1fr;
    gap: 14px;
    padding: 14px 20px;
    align-items: start;
  }
  @media (max-width: 900px) {
    main {
      grid-template-columns: 1fr;
    }
  }
  .loading {
    padding: 60px;
    text-align: center;
    color: var(--muted);
  }
  .panel {
    background: var(--surface);
    border: 1px solid var(--border);
    border-radius: 10px;
    padding: 14px;
  }
  .panel h2 {
    font-size: 14px;
    text-transform: uppercase;
    letter-spacing: 0.8px;
    display: flex;
    align-items: center;
    gap: 8px;
    margin-bottom: 6px;
  }
  .hint {
    color: var(--muted);
    font-size: 12px;
    margin-bottom: 10px;
    line-height: 1.5;
  }
  .badge {
    font-size: 11px;
    padding: 2px 8px;
    border-radius: 999px;
    text-transform: none;
    letter-spacing: 0;
  }
  .badge.synced {
    background: #14301f;
    color: var(--ok);
  }
  .badge.drifts {
    background: #33250f;
    color: var(--warn);
  }
  .badge.not-installed {
    background: #331414;
    color: var(--err);
  }
  details {
    border-top: 1px solid var(--border);
    padding: 6px 0;
  }
  summary {
    display: flex;
    justify-content: space-between;
    align-items: center;
    cursor: pointer;
    padding: 4px 0;
  }
  .provider-id {
    font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
    font-size: 13px;
    font-weight: 600;
  }
  .meta {
    color: var(--muted);
    font-size: 12px;
  }
  .models {
    list-style: none;
    padding: 0;
  }
  .models li {
    display: flex;
    justify-content: space-between;
    align-items: center;
    gap: 10px;
    padding: 6px 0 6px 12px;
    border-top: 1px solid #1d232c;
  }
  .model-info {
    display: flex;
    flex-direction: column;
    gap: 2px;
    min-width: 0;
  }
  .model-name {
    font-size: 13px;
  }
  .assign {
    display: flex;
    gap: 6px;
    flex-shrink: 0;
  }
  .check {
    display: flex;
    align-items: center;
    gap: 4px;
    cursor: pointer;
    font-size: 12px;
    font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
    user-select: none;
  }
  .check input {
    accent-color: var(--accent);
  }
  .check .on {
    color: var(--accent);
    font-weight: 600;
  }
  .check .off {
    color: var(--muted);
  }
  .agent-models {
    list-style: none;
    padding: 0;
    display: flex;
    flex-direction: column;
    gap: 10px;
  }
  .agent-provider {
    border: 1px solid var(--border);
    border-radius: 8px;
    padding: 8px 10px;
    display: flex;
    flex-direction: column;
    gap: 6px;
  }
  .chips {
    display: flex;
    flex-wrap: wrap;
    gap: 4px;
  }
  .chip {
    font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
    font-size: 11px;
    background: var(--bg);
    border: 1px solid var(--border);
    border-radius: 4px;
    padding: 2px 6px;
    color: var(--fg);
  }
  .error {
    color: var(--err);
    font-size: 12px;
  }
  .console {
    margin: 0 20px 20px;
    background: var(--surface);
    border: 1px solid var(--border);
    border-radius: 10px;
    overflow: hidden;
  }
  .console-toggle {
    border: none;
    border-radius: 0;
    width: 100%;
    text-align: left;
    padding: 8px 14px;
    color: var(--muted);
    background: transparent;
  }
  .console pre {
    padding: 10px 14px;
    font-size: 12px;
    line-height: 1.5;
    color: var(--fg);
    max-height: 240px;
    overflow: auto;
    white-space: pre-wrap;
    word-break: break-word;
    border-top: 1px solid var(--border);
  }
  .modal-backdrop {
    position: fixed;
    inset: 0;
    background: rgba(0, 0, 0, 0.6);
    display: flex;
    align-items: center;
    justify-content: center;
    z-index: 20;
  }
  .modal {
    background: var(--surface);
    border: 1px solid var(--border);
    border-radius: 12px;
    padding: 20px;
    max-width: 480px;
    display: flex;
    flex-direction: column;
    gap: 12px;
  }
  .modal h3 {
    font-size: 15px;
  }
  .modal p {
    color: var(--muted);
    font-size: 13px;
    line-height: 1.6;
  }
  .modal-actions {
    display: flex;
    justify-content: flex-end;
    gap: 10px;
  }
</style>
