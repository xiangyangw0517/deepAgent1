(() => {
  const $ = (sel) => document.querySelector(sel);

  const healthDot = $("#healthDot");
  const healthText = $("#healthText");
  const messagesEl = $("#messages");
  const chatForm = $("#chatForm");
  const messageInput = $("#messageInput");
  const sendBtn = $("#sendBtn");
  const sessionIdEl = $("#sessionId");
  const runPanel = $("#runPanel");
  const runPhase = $("#runPhase");
  const runTimer = $("#runTimer");
  const runSteps = $("#runSteps");

  let sessionId = createSessionId();
  let busy = false;
  let timerHandle = null;
  let runStartedAt = 0;
  let streamAbort = null;
  const pendingTools = new Map();

  sessionIdEl.textContent = sessionId;
  pushSystem("你好，我是小智。可以直接描述诉求，或点上方快捷场景试试。");
  resetRunPanel("待命");

  $("#refreshBtn").addEventListener("click", () => loadDashboard());
  $("#newSessionBtn").addEventListener("click", () => {
    sessionId = createSessionId();
    sessionIdEl.textContent = sessionId;
    parkRunPanel();
    messagesEl.innerHTML = "";
    pushSystem("已开启新会话。");
    resetRunPanel("待命");
  });

  document.querySelectorAll("#promptChips [data-prompt]").forEach((btn) => {
    btn.addEventListener("click", () => {
      messageInput.value = btn.dataset.prompt;
      messageInput.focus();
    });
  });

  async function trySendOrStop() {
    // 运行中再点 = 停止（勿用 submit+required，空输入会拦掉点击）
    if (busy) {
      if (streamAbort) {
        setRunPhase("正在停止…");
        try {
          streamAbort.abort();
        } catch (_) {
          /* ignore */
        }
      }
      return;
    }
    const text = messageInput.value.trim();
    if (!text) {
      messageInput.focus();
      return;
    }
    messageInput.value = "";
    await sendMessage(text);
  }

  chatForm.addEventListener("submit", async (e) => {
    e.preventDefault();
    await trySendOrStop();
  });

  sendBtn.addEventListener("click", async (e) => {
    e.preventDefault();
    await trySendOrStop();
  });

  messageInput.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      if (busy) return;
      trySendOrStop();
    }
  });

  const agentDock = initAgentDock();
  window.agentDock = agentDock;

  init();

  async function init() {
    await Promise.all([checkHealth(), loadDashboard()]);
  }

  function createSessionId() {
    return `web-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`;
  }

  async function checkHealth() {
    const badge = document.getElementById("healthBadge");
    try {
      const res = await fetch("/api/health");
      if (!res.ok) throw new Error("bad status");
      if (healthDot) healthDot.className = "status-dot ok";
      if (healthText) healthText.textContent = "服务正常";
      if (badge) {
        badge.hidden = false;
        badge.textContent = "服务正常";
        badge.className = "badge";
      }
    } catch {
      if (healthDot) healthDot.className = "status-dot bad";
      if (healthText) healthText.textContent = "服务不可用";
      if (badge) {
        badge.hidden = false;
        badge.textContent = "服务不可用";
        badge.className = "badge demo";
      }
    }
  }

  async function loadDashboard() {
    // 受理看板已下线；刷新触发重投工作台重新拉数
    window.dispatchEvent(new Event("rework:refresh"));
  }

  function renderKpis(stats) {
    animateNumber('[data-kpi="today"]', stats.today);
    animateNumber('[data-kpi="processing"]', stats.processing);
    animateNumber('[data-kpi="urgent"]', stats.urgent);
    animateNumber('[data-kpi="closed"]', stats.closed);
  }

  function animateNumber(selector, target) {
    const el = $(selector);
    if (!el) return;
    const from = Number(el.textContent) || 0;
    const to = Number(target) || 0;
    if (from === to) {
      el.textContent = String(to);
      return;
    }
    const start = performance.now();
    const dur = 450;
    const tick = (now) => {
      const p = Math.min(1, (now - start) / dur);
      el.textContent = String(Math.round(from + (to - from) * p));
      if (p < 1) requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  }

  async function renderChongtou(payload) {
    if (!payload || payload.ok === false) {
      chongtouMeta.textContent = payload?.error || "暂无三节点数据";
      chongtouBody.innerHTML = "";
      chongtouFilter.innerHTML = "";
      return;
    }
    chongtouCities = Array.isArray(payload.cities) ? payload.cities.slice() : [];
    chongtouProvince = payload.province || null;
    const period = payload.period || "";
    const file = payload.source_file || "";
    chongtouMeta.textContent = `${period}${file ? ` · ${file}` : ""} · 口径：三级节点`;

    chongtouFilter.innerHTML = chongtouCities
      .map(
        (c) =>
          `<label><input type="checkbox" value="${escapeHtml(c.name)}" checked> ${escapeHtml(c.name)}</label>`
      )
      .join("");
    chongtouFilter.querySelectorAll("input").forEach((el) => {
      el.addEventListener("change", () => refreshChongtouView());
    });

    if (window.HunanMap) await window.HunanMap.ensureMap();
    refreshChongtouView();
  }

  function selectedChongtouNames() {
    const boxes = chongtouFilter.querySelectorAll("input[type=checkbox]");
    const out = [];
    boxes.forEach((b) => {
      if (b.checked) out.push(b.value);
    });
    return out;
  }

  function refreshChongtouView() {
    const sel = new Set(selectedChongtouNames());
    const rows = chongtouCities.filter((c) => sel.has(c.name));
    let orders = 0;
    let repeat = 0;
    rows.forEach((c) => {
      orders += Number(c.orders) || 0;
      repeat += Number(c.repeat) || 0;
    });
    const rate = orders > 0 ? (repeat / orders) * 100 : 0;

    setText('[data-ct="orders"]', formatInt(orders));
    setText('[data-ct="repeat"]', formatInt(repeat));
    setText('[data-ct="rate"]', `${rate.toFixed(2)}%`);
    setText('[data-ct="cities"]', String(sel.size));

    const bodyRows = chongtouCities
      .map((c) => {
        const on = sel.has(c.name);
        return `<tr class="${on ? "" : "is-off"}" data-city="${escapeHtml(c.name)}">
          <td>${escapeHtml(c.name)}</td>
          <td class="num">${formatInt(c.orders)}</td>
          <td class="num">${formatInt(c.repeat)}</td>
          <td class="num">${Number(c.rate || 0).toFixed(2)}%</td>
        </tr>`;
      })
      .join("");
    const totalLabel =
      sel.size === chongtouCities.length && chongtouProvince
        ? `全省（表） ${Number(chongtouProvince.rate || 0).toFixed(2)}%`
        : "勾选合计";
    chongtouBody.innerHTML =
      bodyRows +
      `<tr class="total"><td>${totalLabel}</td><td class="num">${formatInt(orders)}</td><td class="num">${formatInt(repeat)}</td><td class="num">${rate.toFixed(2)}%</td></tr>`;

    renderChongtouMap(rows);
  }

  function renderChongtouMap(rows) {
    if (!chongtouMapEl || typeof echarts === "undefined") return;
    if (!chongtouChart) {
      chongtouChart = echarts.init(chongtouMapEl);
      window.addEventListener("resize", () => chongtouChart && chongtouChart.resize());
    }
    const data = rows.map((c) => ({
      name: c.map_name || c.name,
      value: Number(c.rate) || 0,
      orders: c.orders,
      repeat: c.repeat,
      shortName: c.name,
    }));
    const maxRate = Math.max(...data.map((d) => d.value), 1);
    chongtouChart.setOption(
      {
        tooltip: {
          trigger: "item",
          formatter(p) {
            const d = p.data || {};
            if (d.shortName == null && p.name) return p.name;
            return `${d.shortName || p.name}<br/>重投率 ${Number(d.value || 0).toFixed(2)}%<br/>工单 ${formatInt(d.orders)} · 重投 ${formatInt(d.repeat)}`;
          },
        },
        visualMap: {
          min: 0,
          max: Math.ceil(maxRate * 10) / 10 || 1,
          left: 8,
          bottom: 8,
          text: ["高", "低"],
          calculable: true,
          inRange: { color: ["#e0f2fe", "#0284c7", "#0c4a6e"] },
          textStyle: { color: "#64748b", fontSize: 11 },
        },
        series: [
          {
            name: "三级重投率",
            type: "map",
            map: "hunan",
            roam: true,
            scaleLimit: { min: 0.8, max: 4 },
            emphasis: {
              label: { show: true },
              itemStyle: { areaColor: "#38bdf8" },
            },
            data,
          },
        ],
      },
      { notMerge: true }
    );
  }

  function setText(sel, text) {
    const el = $(sel);
    if (el) el.textContent = text;
  }

  function formatInt(n) {
    const v = Number(n) || 0;
    return v.toLocaleString("zh-CN");
  }

  function renderAgents(subagents, toolsCount) {
    const names = Object.keys(subagents);
    capabilityMeta.textContent = `${names.length} 个子智能体 · ${toolsCount} 个工具`;
    agentList.innerHTML = names.length
      ? names
          .map(
            (name) => `
          <li>
            <strong>${escapeHtml(name)}</strong>
            <span>${escapeHtml(subagents[name] || "")}</span>
          </li>`
          )
          .join("")
      : `<li><span>暂无子智能体</span></li>`;
  }

  function renderTickets(tickets) {
    if (!ticketBody) return;
    if (!tickets.length) {
      ticketBody.innerHTML = `<tr><td colspan="6">暂无工单</td></tr>`;
      return;
    }
    ticketBody.innerHTML = tickets
      .map((t) => {
        const urgencyClass = t.urgency === "普通" ? "" : "urgent";
        const statusClass = t.status === "已办结" ? "ok" : t.status === "处理中" ? "warn" : "";
        return `
          <tr>
            <td>${escapeHtml(t.ticket_id)}</td>
            <td><span class="tag">${escapeHtml(t.category)}</span></td>
            <td>${escapeHtml(t.summary)}</td>
            <td><span class="tag ${urgencyClass}">${escapeHtml(t.urgency)}</span></td>
            <td><span class="tag ${statusClass}">${escapeHtml(t.status)}</span></td>
            <td>${escapeHtml(formatTime(t.created_at))}</td>
          </tr>`;
      })
      .join("");
  }

  function pushSystem(text) {
    const div = document.createElement("div");
    div.className = "msg system";
    div.textContent = text;
    messagesEl.appendChild(div);
  }

  function pushMessage(role, text = "") {
    const div = document.createElement("div");
    div.className = `msg ${role}`;
    if (role === "assistant") {
      const body = document.createElement("div");
      body.className = "msg-body md-body";
      if (text) renderMarkdown(body, text);
      div.appendChild(body);
    } else {
      div.textContent = text;
    }
    messagesEl.appendChild(div);
    messagesEl.scrollTop = messagesEl.scrollHeight;
    return div;
  }

  function disposeEcharts(el) {
    if (!el || typeof echarts === "undefined") return;
    el.querySelectorAll(".echarts-host").forEach((node) => {
      const inst = echarts.getInstanceByDom(node);
      if (inst) inst.dispose();
    });
  }

  function extractEchartsBlocks(md) {
    const options = [];
    const replaced = String(md).replace(/```echarts[ \t]*\r?\n([\s\S]*?)```/gi, (_, body) => {
      const idx = options.length;
      options.push(String(body).trim());
      return `\n\n@@ECHARTS_${idx}@@\n\n`;
    });
    return { md: replaced, options };
  }

  function injectEchartsHosts(html, options, { pending = false } = {}) {
    let out = html;
    for (let i = 0; i < options.length; i++) {
      const cls = pending ? "echarts-host is-pending" : "echarts-host";
      const label = pending ? "图表渲染中…" : "";
      const host = `<div class="${cls}" data-echarts-idx="${i}">${label}</div>`;
      const token = `@@ECHARTS_${i}@@`;
      out = out
        .replace(`<p>${token}</p>`, host)
        .replace(`<p>${token}<br></p>`, host)
        .replace(token, host);
    }
    return out;
  }

  function mountEcharts(el, options) {
    if (!el || !options || !options.length) return;
    if (typeof echarts === "undefined") {
      el.querySelectorAll(".echarts-host").forEach((node) => {
        node.classList.add("is-error");
        node.textContent = "未加载 ECharts 库";
      });
      return;
    }
    el.querySelectorAll(".echarts-host").forEach((node) => {
      const idx = Number(node.dataset.echartsIdx);
      const rawOpt = options[idx];
      if (rawOpt == null) return;
      let option;
      try {
        option = JSON.parse(rawOpt);
      } catch (err) {
        node.classList.add("is-error");
        node.classList.remove("is-pending");
        node.textContent = `图表配置无法解析：${err.message || err}`;
        return;
      }
      node.classList.remove("is-pending", "is-error");
      node.textContent = "";
      const chart = echarts.init(node, null, { renderer: "canvas" });
      chart.setOption(option, { notMerge: true });
      if (!el._echartsResizeBound) {
        el._echartsResizeBound = true;
        const onResize = () => {
          el.querySelectorAll(".echarts-host").forEach((n) => {
            const inst = echarts.getInstanceByDom(n);
            if (inst) inst.resize();
          });
        };
        window.addEventListener("resize", onResize);
        el._echartsOnResize = onResize;
      }
    });
  }

  /** 文末「数据来源」包淡蓝底：段落 / 含「数据来源」表头的表格 */
  function enhanceDataSourceBlock(html) {
    if (!html || /class=["'][^"']*\bdata-source\b/.test(html)) return html;
    // 表头含「数据来源」的 table（优先，匹配 skill 推荐版式）
    let out = html.replace(
      /(<table[\s\S]*?<th[^>]*>\s*数据来源\s*<\/th>[\s\S]*?<\/table>)/i,
      '<div class="data-source">$1</div>'
    );
    if (out !== html) return out;
    out = html.replace(
      /(<p[^>]*>)\s*(?:<strong>)?数据来源(?:<\/strong>)?\s*([:：][\s\S]*?<\/p>)/i,
      '<div class="data-source">$1<strong>数据来源</strong>$2</div>'
    );
    if (out !== html) return out;
    out = html.replace(
      /<(?:h[1-6])[^>]*>\s*数据来源\s*<\/(?:h[1-6])>\s*(<p[\s\S]*?<\/p>)/i,
      '<div class="data-source"><p><strong>数据来源</strong></p>$1</div>'
    );
    return out;
  }

  function renderMarkdown(el, md, { mountCharts = true } = {}) {
    if (!el) return;
    const raw = md == null ? "" : String(md);
    disposeEcharts(el);
    if (!raw) {
      el.innerHTML = "";
      el._echartsOptions = [];
      return;
    }
    try {
      const { md: withTokens, options } = extractEchartsBlocks(raw);
      let html =
        typeof marked !== "undefined" && marked.parse
          ? marked.parse(withTokens, { breaks: true, gfm: true })
          : escapeHtml(withTokens).replaceAll("\n", "<br>");
      html = injectEchartsHosts(html, options, { pending: !mountCharts });
      html = enhanceDataSourceBlock(html);
      el.innerHTML =
        typeof DOMPurify !== "undefined"
          ? DOMPurify.sanitize(html, {
              USE_PROFILES: { html: true },
              ADD_ATTR: ["data-echarts-idx", "class"],
              ADD_TAGS: ["div"],
            })
          : html;
      el._echartsOptions = options;
      if (mountCharts) {
        // 等布局完成后再 init，避免宽高为 0
        requestAnimationFrame(() => mountEcharts(el, options));
      }
    } catch (err) {
      console.error(err);
      el.textContent = raw;
    }
  }

  function createMarkdownStreamer(el) {
    let raw = "";
    let scheduled = false;
    const flush = () => {
      scheduled = false;
      // 流式阶段只占位，避免反复 init 图表
      renderMarkdown(el, raw, { mountCharts: false });
      messagesEl.scrollTop = messagesEl.scrollHeight;
    };
    return {
      append(chunk) {
        raw += chunk;
        if (!scheduled) {
          scheduled = true;
          requestAnimationFrame(flush);
        }
      },
      finish() {
        if (scheduled) {
          scheduled = false;
        }
        renderMarkdown(el, raw, { mountCharts: true });
        messagesEl.scrollTop = messagesEl.scrollHeight;
        return raw;
      },
      get text() {
        return raw;
      },
      set text(v) {
        raw = v == null ? "" : String(v);
        renderMarkdown(el, raw, { mountCharts: true });
      },
    };
  }

  /** 对齐 LangChain SubagentCard：插在运行过程与主气泡之间，不混入回答 */
  function createSubagentCardHost(assistantEl) {
    const host = document.createElement("div");
    host.className = "subagent-host";
    // 与 run-panel 同级：运行过程 → 子智能体卡片 → 助手气泡
    if (assistantEl && assistantEl.parentNode === messagesEl) {
      messagesEl.insertBefore(host, assistantEl);
    } else {
      messagesEl.appendChild(host);
    }

    const cards = new Map();

    function statusLabel(status) {
      if (status === "running") return "运行中";
      if (status === "complete") return "已完成";
      if (status === "error") return "失败";
      return status || "";
    }

    function ensure(id, name) {
      let card = cards.get(id);
      if (card) {
        if (name && name !== "子智能体" && name !== card.name) {
          card.name = name;
          card.nameEl.textContent = name;
        }
        return card;
      }

      const details = document.createElement("details");
      details.className = "subagent-card";
      details.open = true;
      details.dataset.status = "running";

      const summary = document.createElement("summary");
      summary.className = "subagent-card-summary";

      const left = document.createElement("div");
      left.className = "subagent-card-heading";

      const pulse = document.createElement("span");
      pulse.className = "subagent-pulse";
      pulse.setAttribute("aria-hidden", "true");

      const nameEl = document.createElement("span");
      nameEl.className = "subagent-name";
      nameEl.textContent = name || "子智能体";

      const meta = document.createElement("span");
      meta.className = "subagent-meta";
      meta.textContent = "0 次工具调用";

      left.append(pulse, nameEl, meta);

      const badge = document.createElement("span");
      badge.className = "subagent-badge";
      badge.textContent = "运行中";

      summary.append(left, badge);

      const body = document.createElement("div");
      body.className = "subagent-card-body";

      const toolsEl = document.createElement("ul");
      toolsEl.className = "subagent-tools";

      const msgEl = document.createElement("div");
      msgEl.className = "subagent-messages md-body";

      body.append(toolsEl, msgEl);
      details.append(summary, body);
      host.appendChild(details);
      host.hidden = false;

      const md = createMarkdownStreamer(msgEl);
      const tools = new Map();

      card = {
        id,
        name: name || "子智能体",
        status: "running",
        el: details,
        nameEl,
        meta,
        badge,
        toolsEl,
        msgEl,
        md,
        tools,
        refreshMeta() {
          const n = tools.size;
          meta.textContent = `${n} 次工具调用`;
        },
        setStatus(status) {
          this.status = status;
          details.dataset.status = status;
          badge.textContent = statusLabel(status);
          // 运行中展开；完成/失败后自动收起，需要可再点开
          details.open = status === "running";
        },
      };
      cards.set(id, card);
      messagesEl.scrollTop = messagesEl.scrollHeight;
      return card;
    }

    host.hidden = true;

    return {
      handle(payload) {
        const action = payload.action;
        const id = payload.id;
        if (!id || !action) return;

        if (action === "start" || action === "update") {
          const c = ensure(id, payload.name);
          c.setStatus(payload.status || "running");
          return;
        }

        const c = cards.get(id) || ensure(id, payload.name);

        if (action === "token") {
          c.md.append(payload.text || "");
          return;
        }

        if (action === "tool_call") {
          const tid = String(payload.tool_id || payload.name || "");
          if (!tid || c.tools.has(tid)) return;
          const li = document.createElement("li");
          li.className = "subagent-tool is-running";
          li.innerHTML = `<span class="t-name">${escapeHtml(
            payload.label || payload.name || "工具"
          )}</span><span class="t-state">进行中</span>`;
          c.toolsEl.appendChild(li);
          c.tools.set(tid, li);
          c.refreshMeta();
          messagesEl.scrollTop = messagesEl.scrollHeight;
          return;
        }

        if (action === "tool_result") {
          const tid = String(payload.tool_id || payload.name || "");
          let li = tid ? c.tools.get(tid) : null;
          if (!li) {
            li = document.createElement("li");
            c.toolsEl.appendChild(li);
            if (tid) c.tools.set(tid, li);
          }
          const ok = payload.ok !== false;
          li.className = `subagent-tool ${ok ? "is-ok" : "is-err"}`;
          const preview = payload.preview
            ? `<div class="t-preview">${escapeHtml(payload.preview)}</div>`
            : "";
          li.innerHTML = `<span class="t-name">${escapeHtml(
            payload.label || payload.name || "工具"
          )}</span><span class="t-state">${ok ? "完成" : "失败"}</span>${preview}`;
          c.refreshMeta();
          return;
        }

        if (action === "done") {
          if (payload.name) {
            c.name = payload.name;
            c.nameEl.textContent = payload.name;
          }
          c.setStatus(payload.status || "complete");
          if (payload.output && !String(c.md.text || "").trim()) {
            c.md.text = payload.output;
          } else {
            c.md.finish();
          }
        }
      },
      finishAll(status = "complete") {
        cards.forEach((c) => {
          if (c.status === "running") {
            c.setStatus(status);
            c.md.finish();
          }
        });
      },
      get size() {
        return cards.size;
      },
    };
  }

  function parkRunPanel() {
    const dock = messagesEl.nextElementSibling;
    if (runPanel.parentNode !== messagesEl.parentNode || dock !== runPanel) {
      messagesEl.insertAdjacentElement("afterend", runPanel);
    }
    runPanel.hidden = true;
  }

  function placeRunPanelBefore(assistantEl) {
    runPanel.hidden = false;
    if (assistantEl && assistantEl.parentNode === messagesEl) {
      messagesEl.insertBefore(runPanel, assistantEl);
    } else {
      messagesEl.appendChild(runPanel);
    }
  }

  function resetRunPanel(phaseText) {
    stopTimer();
    runPanel.classList.remove("running", "done", "error");
    runPanel.open = false;
    runSteps.innerHTML = "";
    pendingTools.clear();
    runTimer.textContent = "0.0s";
    setRunPhase(phaseText || "待命");
    if (!messagesEl.contains(runPanel)) {
      runPanel.hidden = true;
    }
  }

  function beginRun() {
    stopTimer();
    pendingTools.clear();
    runSteps.innerHTML = "";
    runPanel.hidden = false;
    runPanel.classList.remove("done", "error");
    runPanel.classList.add("running");
    runPanel.open = true;
    runStartedAt = performance.now();
    runTimer.textContent = "0.0s";
    setRunPhase("启动中…");
    timerHandle = setInterval(() => {
      runTimer.textContent = formatSeconds(performance.now() - runStartedAt);
    }, 100);
  }

  function finishRun(ok, phaseText, serverElapsedMs) {
    stopTimer();
    runPanel.classList.remove("running");
    runPanel.classList.add(ok ? "done" : "error");
    if (typeof serverElapsedMs === "number") {
      runTimer.textContent = formatSeconds(serverElapsedMs);
    } else {
      runTimer.textContent = formatSeconds(performance.now() - runStartedAt);
    }
    setRunPhase(phaseText);
    // 收起详情，把空间留给下方回答；需要时可再点开
    runPanel.open = false;
  }

  function stopTimer() {
    if (timerHandle) {
      clearInterval(timerHandle);
      timerHandle = null;
    }
  }

  function setRunPhase(text) {
    runPhase.textContent = text || "";
  }

  function addStep({ title, detail, state = "active", durationText = "" }) {
    const li = document.createElement("li");
    li.className = `run-step ${state}`;
    li.innerHTML = `
      <span class="dot"></span>
      <div class="meta">
        <strong></strong>
        <span class="preview"></span>
      </div>
      <span class="dur"></span>`;
    li.querySelector("strong").textContent = title;
    li.querySelector(".preview").textContent = detail || "";
    li.querySelector(".dur").textContent = durationText;
    runSteps.appendChild(li);
    runSteps.scrollTop = runSteps.scrollHeight;
    return li;
  }

  function markStep(el, state, durationText, detail) {
    if (!el) return;
    el.classList.remove("active", "ok", "err");
    el.classList.add(state);
    if (durationText != null) el.querySelector(".dur").textContent = durationText;
    if (detail) el.querySelector(".preview").textContent = detail;
  }

  function formatSeconds(ms) {
    return `${(Number(ms) / 1000).toFixed(1)}s`;
  }

  function parseJson(data) {
    try {
      return JSON.parse(data);
    } catch {
      return null;
    }
  }

  function setBusy(on) {
    busy = on;
    sendBtn.textContent = on ? "停止" : "发送";
    sendBtn.classList.toggle("is-stop", on);
    sendBtn.setAttribute("aria-label", on ? "停止生成" : "发送消息");
    agentDock.setBusy(on);
  }

  function initAgentDock() {
    const fab = $("#agentFab");
    const panel = $("#chatPanel");
    const tip = $("#agentFabTip");
    const resizeHandle = $("#chatResize");
    const posKey = "deepagent-fab-pos";
    const widthKey = "deepagent-chat-width";
    const FAB_TIPS = [
      "嗨，我是小智。查数据、找根因，交给我吧",
      "遇到难啃的工单了？点我帮您查工单、看数据、理根因",
      "看板数据有疑问？点我帮你查",
    ];
    let drag = null;
    let resizeDrag = null;
    let tipIdx = Math.floor(Math.random() * FAB_TIPS.length);
    let tipShowTimer = null;
    let tipHideTimer = null;
    let tipBusy = false;
    let closeTimer = null;

    function clearTipTimers() {
      if (tipShowTimer) clearTimeout(tipShowTimer);
      if (tipHideTimer) clearTimeout(tipHideTimer);
      tipShowTimer = null;
      tipHideTimer = null;
    }

    function canAutoTip() {
      return !tipBusy && !panel.classList.contains("on") && !fab.classList.contains("is-dragging");
    }

    function scheduleFabTip(delayMs) {
      clearTipTimers();
      fab.classList.remove("is-tipping");
      if (!tip || !canAutoTip()) return;
      const wait = delayMs != null ? delayMs : 7000 + Math.random() * 5000;
      tipShowTimer = setTimeout(() => {
        if (!canAutoTip()) {
          scheduleFabTip();
          return;
        }
        tip.textContent = FAB_TIPS[tipIdx % FAB_TIPS.length];
        tipIdx += 1;
        fab.classList.add("is-tipping");
        tipHideTimer = setTimeout(() => {
          fab.classList.remove("is-tipping");
          scheduleFabTip();
        }, 4500);
      }, wait);
    }

    function clamp(n, min, max) {
      return Math.min(Math.max(n, min), max);
    }

    function applyFab(x, y) {
      const pad = 10;
      const width = fab.offsetWidth || 104;
      const height = fab.offsetHeight || 128;
      const hw = width / 2;
      // 允许拖到左右边缘半隐藏
      const nextX = clamp(x, -hw + 6, window.innerWidth - hw - 6);
      const nextY = clamp(y, pad, window.innerHeight - height - pad);
      fab.style.left = `${nextX}px`;
      fab.style.top = `${nextY}px`;
      fab.style.right = "auto";
      fab.style.bottom = "auto";
      const half =
        nextX < pad + hw * 0.35 || nextX + width > window.innerWidth - pad - hw * 0.35;
      fab.classList.toggle("is-edge-hidden", half);
      return { x: nextX, y: nextY };
    }

    function snapFabEdge() {
      const r = fab.getBoundingClientRect();
      const hw = r.width / 2;
      const pad = 10;
      if (r.left < pad + hw * 0.4) applyFab(-hw + 6, r.top);
      else if (r.right > window.innerWidth - pad - hw * 0.4) applyFab(window.innerWidth - hw / 2 - 6, r.top);
      else applyFab(r.left, r.top);
    }

    function readWidth() {
      try {
        const w = Number(localStorage.getItem(widthKey));
        if (Number.isFinite(w) && w >= 300) return w;
      } catch {
        /* ignore */
      }
      return 400;
    }

    function applySideWidth(w) {
      const minW = 300;
      const maxW = Math.max(minW, Math.min(720, window.innerWidth * 0.92));
      const next = clamp(w, minW, maxW);
      panel.style.width = `${next}px`;
      panel.style.setProperty("--chat-w", `${next}px`);
      return next;
    }

    function placePanel() {
      panel.style.top = "0";
      panel.style.right = "0";
      panel.style.left = "auto";
      panel.style.height = "100%";
      panel.style.maxHeight = "none";
      applySideWidth(readWidth());
    }

    function setOpen(open) {
      if (closeTimer) {
        clearTimeout(closeTimer);
        closeTimer = null;
      }
      fab.setAttribute("aria-expanded", open ? "true" : "false");
      fab.setAttribute("aria-label", open ? "关闭投诉对话" : "打开投诉对话");
      if (open) {
        panel.hidden = false;
        placePanel();
        clearTipTimers();
        fab.classList.remove("is-tipping");
        requestAnimationFrame(() => panel.classList.add("on"));
        messageInput.focus();
      } else {
        panel.classList.remove("on");
        closeTimer = setTimeout(() => {
          panel.hidden = true;
          closeTimer = null;
        }, 300);
        if (!tipBusy) scheduleFabTip(1800);
      }
    }

    function openChat(opts = {}) {
      setOpen(true);
      if (opts.prompt) {
        messageInput.value = opts.prompt;
        messageInput.focus();
      }
    }

    function savedPos() {
      try {
        const raw = localStorage.getItem(posKey);
        if (!raw) return null;
        const pos = JSON.parse(raw);
        if (typeof pos.x === "number" && typeof pos.y === "number") return pos;
      } catch {
        /* 忽略损坏的本地位置 */
      }
      return null;
    }

    const saved = savedPos();
    if (saved) applyFab(saved.x, saved.y);
    else applyFab(window.innerWidth - 120, window.innerHeight - 150);
    placePanel();

    fab.addEventListener("pointerdown", (e) => {
      if (e.button !== 0) return;
      const rect = fab.getBoundingClientRect();
      drag = {
        id: e.pointerId,
        sx: e.clientX,
        sy: e.clientY,
        ox: rect.left,
        oy: rect.top,
        moved: false,
      };
      fab.setPointerCapture(e.pointerId);
      fab.classList.add("is-dragging");
    });

    fab.addEventListener("pointermove", (e) => {
      if (!drag || e.pointerId !== drag.id) return;
      const dx = e.clientX - drag.sx;
      const dy = e.clientY - drag.sy;
      if (!drag.moved && Math.hypot(dx, dy) < 6) return;
      drag.moved = true;
      applyFab(drag.ox + dx, drag.oy + dy);
    });

    function endDrag(e) {
      if (!drag || e.pointerId !== drag.id) return;
      const moved = drag.moved;
      drag = null;
      fab.classList.remove("is-dragging");
      if (moved) {
        snapFabEdge();
        const rect = fab.getBoundingClientRect();
        try {
          localStorage.setItem(posKey, JSON.stringify({ x: rect.left, y: rect.top }));
        } catch {
          /* 隐私模式写不进也没关系 */
        }
        if (!tipBusy && !panel.classList.contains("on")) scheduleFabTip(2500);
        return;
      }
      setOpen(!panel.classList.contains("on"));
    }

    fab.addEventListener("pointerup", endDrag);
    fab.addEventListener("pointercancel", (e) => {
      if (!drag || e.pointerId !== drag.id) return;
      drag = null;
      fab.classList.remove("is-dragging");
      snapFabEdge();
      if (!tipBusy && !panel.classList.contains("on")) scheduleFabTip(2500);
    });

    resizeHandle.addEventListener("pointerdown", (e) => {
      if (e.button !== 0) return;
      e.stopPropagation();
      resizeDrag = {
        id: e.pointerId,
        sx: e.clientX,
        w: panel.getBoundingClientRect().width,
      };
      resizeHandle.setPointerCapture(e.pointerId);
      panel.classList.add("is-resizing");
    });

    window.addEventListener("pointermove", (e) => {
      if (!resizeDrag || e.pointerId !== resizeDrag.id) return;
      const dx = e.clientX - resizeDrag.sx;
      // 向左拖 → 变宽
      applySideWidth(resizeDrag.w - dx);
    });

    function endResize(e) {
      if (!resizeDrag || e.pointerId !== resizeDrag.id) return;
      resizeDrag = null;
      panel.classList.remove("is-resizing");
      try {
        localStorage.setItem(widthKey, String(panel.getBoundingClientRect().width));
      } catch {
        /* ignore */
      }
    }

    window.addEventListener("pointerup", endResize);
    window.addEventListener("pointercancel", endResize);

    $("#chatCloseBtn").addEventListener("click", () => setOpen(false));
    document.addEventListener("keydown", (e) => {
      if (e.key === "Escape" && panel.classList.contains("on")) setOpen(false);
    });
    window.addEventListener("resize", () => {
      const rect = fab.getBoundingClientRect();
      applyFab(rect.left, rect.top);
      if (panel.classList.contains("on")) placePanel();
    });

    scheduleFabTip(2200);

    return {
      open: openChat,
      setOpen,
      setBusy(on) {
        tipBusy = on;
        fab.classList.toggle("is-busy", on);
        if (!tip) return;
        if (on) {
          clearTipTimers();
          fab.classList.remove("is-tipping");
          tip.textContent = "回复中…";
        } else if (!panel.classList.contains("on")) {
          tip.textContent = FAB_TIPS[(tipIdx + FAB_TIPS.length - 1) % FAB_TIPS.length] || FAB_TIPS[0];
          scheduleFabTip(2500);
        }
      },
    };
  }

  async function sendMessage(text) {
    if (streamAbort) {
      streamAbort.abort();
      streamAbort = null;
    }
    const abortCtrl = new AbortController();
    streamAbort = abortCtrl;

    setBusy(true);
    pushMessage("user", text);
    const assistantEl = pushMessage("assistant", "");
    placeRunPanelBefore(assistantEl);
    beginRun();
    const bodyEl = assistantEl.querySelector(".msg-body");
    const mdStream = createMarkdownStreamer(bodyEl);
    const subagentCards = createSubagentCardHost(assistantEl);
    const toolsUsed = new Set();
    let writingStep = null;
    let userStopped = false;
    let streamEnded = false;

    try {
      const res = await fetch("/api/chat/stream", {
        method: "POST",
        headers: { "Content-Type": "application/json", Accept: "text/event-stream" },
        body: JSON.stringify({ session_id: sessionId, message: text }),
        signal: abortCtrl.signal,
      });
      if (!res.ok || !res.body) {
        const errText = await res.text();
        throw new Error(errText || `HTTP ${res.status}`);
      }

      const reader = res.body.getReader();
      const onAbort = () => {
        reader.cancel().catch(() => {});
      };
      if (abortCtrl.signal.aborted) onAbort();
      else abortCtrl.signal.addEventListener("abort", onAbort, { once: true });
      const decoder = new TextDecoder();
      let buffer = "";
      let eventName = "message";
      let dataLines = [];
      let finalElapsed = null;

      const flushEvent = () => {
        const data = dataLines.join("\n");
        dataLines = [];
        handleStreamEvent(eventName, data);
        eventName = "message";
      };

      const handleStreamEvent = (event, data) => {
        if (event === "token") {
          mdStream.append(data);
          return;
        }

        const payload = parseJson(data) || {};

        if (event === "run_start") {
          addStep({
            title: "开始处理",
            detail: payload.label || "已接收请求",
            state: "ok",
            durationText: formatSeconds(payload.elapsed_ms || 0),
          });
          setRunPhase(payload.label || "开始处理");
        } else if (event === "status") {
          setRunPhase(payload.label || "处理中…");
          if (payload.phase === "writing" && !writingStep) {
            writingStep = addStep({
              title: "生成回复",
              detail: "流式输出中…",
              state: "active",
            });
          } else if (payload.phase === "waiting") {
            // 长耗时心跳：刷新当前进行中步骤的说明，避免界面像卡住
            const last = runSteps.querySelector("li.run-step.active:last-child");
            if (last) {
              const preview = last.querySelector(".preview");
              if (preview) preview.textContent = payload.label || "处理中…";
            }
          }
        } else if (event === "tool_call") {
          const key = payload.id || payload.name;
          const el = addStep({
            title: payload.label || payload.name || "调用工具",
            detail:
              payload.detail && payload.detail !== payload.name
                ? `目标：${payload.detail}`
                : payload.name
                  ? `工具：${payload.name}`
                  : "",
            state: "active",
          });
          if (key) pendingTools.set(key, el);
          if (payload.name) toolsUsed.add(payload.name);
          setRunPhase(payload.label ? `正在${payload.label}…` : "调用工具…");
        } else if (event === "tool_result") {
          const keyCandidates = [payload.id, payload.name].filter(Boolean);
          let el = null;
          for (const k of keyCandidates) {
            if (pendingTools.has(k)) {
              el = pendingTools.get(k);
              pendingTools.delete(k);
              break;
            }
          }
          const dur =
            payload.duration_ms != null
              ? formatSeconds(payload.duration_ms)
              : payload.elapsed_ms != null
                ? `@${formatSeconds(payload.elapsed_ms)}`
                : "";
          markStep(
            el ||
              addStep({
                title: payload.label || payload.name || "工具结果",
                state: "active",
              }),
            payload.ok === false ? "err" : "ok",
            dur,
            payload.preview || "完成"
          );
          if (payload.name) toolsUsed.add(payload.name);
          setRunPhase(`${payload.label || payload.name || "工具"}完成`);
        } else if (event === "subagent") {
          subagentCards.handle(payload);
        } else if (event === "aborted") {
          streamEnded = true;
          userStopped = true;
          finalElapsed = payload.elapsed_ms;
          subagentCards.finishAll("error");
          if (writingStep) {
            markStep(writingStep, "err", "", "已中断");
            writingStep = null;
          }
          pendingTools.forEach((el) => markStep(el, "err", "", "已停止"));
          pendingTools.clear();
          addStep({
            title: "已停止",
            detail: payload.label || "用户取消",
            state: "err",
            durationText: formatSeconds(payload.elapsed_ms || 0),
          });
          finishRun(false, `已停止 · ${formatSeconds(payload.elapsed_ms || 0)}`, payload.elapsed_ms);
        } else if (event === "done") {
          streamEnded = true;
          finalElapsed = payload.elapsed_ms;
          subagentCards.finishAll("complete");
          if (writingStep) {
            markStep(writingStep, "ok", "", "已输出");
            writingStep = null;
          }
          pendingTools.forEach((el) => markStep(el, "ok", "", "已结束"));
          pendingTools.clear();
          addStep({
            title: "全部完成",
            detail: payload.steps ? `共 ${payload.steps} 个关键步骤` : "",
            state: "ok",
            durationText: formatSeconds(payload.elapsed_ms || 0),
          });
          finishRun(true, `完成 · 总耗时 ${formatSeconds(payload.elapsed_ms || 0)}`, payload.elapsed_ms);
        }
      };

      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const parts = buffer.split("\n");
        buffer = parts.pop() || "";

        for (const raw of parts) {
          const line = raw.replace(/\r$/, "");
          if (!line) {
            if (dataLines.length || eventName !== "message") flushEvent();
            continue;
          }
          if (line.startsWith("event:")) {
            eventName = line.slice(6).trim();
          } else if (line.startsWith("data:")) {
            dataLines.push(line.slice(5).startsWith(" ") ? line.slice(6) : line.slice(5));
          }
        }
      }
      if (dataLines.length || eventName !== "message") flushEvent();

      const finalText = mdStream.finish();
      if (!finalText.trim()) {
        mdStream.text = userStopped
          ? "（已停止生成）"
          : "（未返回文本，请检查模型配置或稍后重试）";
      }

      if (toolsUsed.size) {
        const chip = document.createElement("div");
        chip.className = "tool-chip";
        chip.textContent = `工具：${[...toolsUsed].join(" · ")}`;
        assistantEl.appendChild(chip);
      }

      if (!streamEnded && runPanel.classList.contains("running")) {
        finishRun(true, `完成 · 总耗时 ${runTimer.textContent}`, finalElapsed);
      }

      // 看板刷新不阻塞结束态，避免「已出完字仍显示停止」约 1s
      if (!userStopped) {
        loadDashboard().catch((err) => console.error(err));
      }
    } catch (err) {
      if (err && (err.name === "AbortError" || abortCtrl.signal.aborted)) {
        userStopped = true;
        subagentCards.finishAll("error");
        const partial = mdStream.finish();
        if (!partial.trim()) {
          mdStream.text = "（已停止生成）";
        }
        if (writingStep) {
          markStep(writingStep, "err", "", "已中断");
          writingStep = null;
        }
        pendingTools.forEach((el) => markStep(el, "err", "", "已停止"));
        pendingTools.clear();
        addStep({
          title: "已停止",
          detail: "用户取消请求",
          state: "err",
        });
        finishRun(false, "已停止");
      } else {
        console.error(err);
        subagentCards.finishAll("error");
        mdStream.text = `请求失败：${err.message || err}`;
        addStep({
          title: "运行失败",
          detail: String(err.message || err),
          state: "err",
        });
        finishRun(false, "对话失败");
      }
    } finally {
      if (streamAbort === abortCtrl) {
        streamAbort = null;
      }
      setBusy(false);
    }
  }

  function formatTime(iso) {
    if (!iso) return "—";
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return iso;
    return d.toLocaleString("zh-CN", { hour12: false });
  }

  function escapeHtml(str) {
    return String(str)
      .replaceAll("&", "&amp;")
      .replaceAll("<", "&lt;")
      .replaceAll(">", "&gt;")
      .replaceAll('"', "&quot;");
  }
})();
