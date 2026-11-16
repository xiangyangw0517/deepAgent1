(() => {
  const $ = (sel, root = document) => root.querySelector(sel);
  const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

  const panes = {
    board: $("#pane-board"),
    chat: $("#pane-chat"),
    mine: $("#pane-mine"),
  };
  const titles = {
    board: "数据看板",
    chat: "投诉对话",
    mine: "我的",
  };

  let sessionId = localStorage.getItem("m_session_id") || crypto.randomUUID();
  localStorage.setItem("m_session_id", sessionId);
  $("#sessionId").textContent = sessionId.slice(0, 8);

  let abortCtrl = null;
  let boardLoaded = false;

  function setTab(name) {
    Object.entries(panes).forEach(([k, el]) => {
      el.hidden = k !== name;
    });
    $$(".tab").forEach((btn) => {
      btn.classList.toggle("is-active", btn.dataset.tab === name);
    });
    $("#topTitle").textContent = titles[name] || "移动投诉智能体";
    $("#filterSelect").hidden = name !== "board";
    $("#refreshBtn").hidden = name !== "board";
    $("#newChatBtn").hidden = name !== "chat";
    if (name === "board" && !boardLoaded) loadBoard();
  }

  $$(".tab").forEach((btn) => {
    btn.addEventListener("click", () => setTab(btn.dataset.tab));
  });

  async function ping() {
    try {
      const r = await fetch("/api/health");
      const ok = r.ok;
      $("#healthText").textContent = ok ? "服务正常" : "服务异常";
    } catch {
      $("#healthText").textContent = "无法连接";
    }
  }

  function addBubble(role, text) {
    const el = document.createElement("div");
    el.className = `bubble ${role}`;
    el.textContent = text;
    $("#messages").appendChild(el);
    el.scrollIntoView({ block: "end" });
    return el;
  }

  async function sendMessage(text) {
    const msg = (text || "").trim();
    if (!msg) return;
    if (abortCtrl) {
      abortCtrl.abort();
      abortCtrl = null;
      $("#sendBtn").textContent = "发送";
      $("#sendBtn").classList.remove("is-stop");
      return;
    }

    addBubble("user", msg);
    $("#messageInput").value = "";
    const bot = addBubble("bot", "…");
    abortCtrl = new AbortController();
    $("#sendBtn").textContent = "停止";
    $("#sendBtn").classList.add("is-stop");

    let full = "";
    try {
      const res = await fetch("/api/chat/stream", {
        method: "POST",
        headers: { "Content-Type": "application/json", Accept: "text/event-stream" },
        body: JSON.stringify({ session_id: sessionId, message: msg }),
        signal: abortCtrl.signal,
      });
      if (!res.ok || !res.body) throw new Error(`HTTP ${res.status}`);
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buf = "";
      let eventName = "message";
      let dataLines = [];

      const flush = () => {
        const data = dataLines.join("\n");
        dataLines = [];
        const ev = eventName;
        eventName = "message";
        if (ev === "token" && data) {
          full += data;
          bot.textContent = full;
        } else if (ev === "error") {
          try {
            const p = JSON.parse(data);
            bot.textContent = p.message || p.detail || data || "出错了";
          } catch {
            bot.textContent = data || "出错了";
          }
        }
      };

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buf += decoder.decode(value, { stream: true });
        const lines = buf.split("\n");
        buf = lines.pop() || "";
        for (const line of lines) {
          if (line.startsWith("event:")) {
            eventName = line.slice(6).trim();
          } else if (line.startsWith("data:")) {
            dataLines.push(line.slice(5).trimStart());
          } else if (line === "") {
            if (dataLines.length) flush();
          }
        }
        bot.scrollIntoView({ block: "end" });
      }
      if (dataLines.length) flush();
      if (!full) bot.textContent = bot.textContent === "…" ? "（无文本回复）" : bot.textContent;
    } catch (e) {
      if (e.name === "AbortError") {
        if (!full) bot.textContent = "已停止";
      } else {
        bot.textContent = `请求失败：${e.message || e}`;
      }
    } finally {
      abortCtrl = null;
      $("#sendBtn").textContent = "发送";
      $("#sendBtn").classList.remove("is-stop");
    }
  }

  $("#chatForm").addEventListener("submit", (e) => {
    e.preventDefault();
    sendMessage($("#messageInput").value);
  });

  $$("#chips [data-prompt]").forEach((btn) => {
    btn.addEventListener("click", () => {
      setTab("chat");
      sendMessage(btn.dataset.prompt);
    });
  });

  $$("[data-ask]").forEach((btn) => {
    btn.addEventListener("click", () => {
      setTab("chat");
      sendMessage(btn.dataset.ask);
    });
  });

  $("#newChatBtn").addEventListener("click", () => {
    sessionId = crypto.randomUUID();
    localStorage.setItem("m_session_id", sessionId);
    $("#sessionId").textContent = sessionId.slice(0, 8);
    $("#messages").innerHTML = "";
    addBubble("sys", "已开始新会话");
  });

  $("#refreshBtn").addEventListener("click", () => {
    boardLoaded = false;
    loadBoard();
  });

  async function loadBoard() {
    boardLoaded = true;
    try {
      const [statsRes, ticketsRes, ctRes] = await Promise.all([
        fetch("/api/dashboard/stats"),
        fetch("/api/dashboard/tickets"),
        fetch("/api/dashboard/chongtou-3node"),
      ]);
      if (statsRes.ok) {
        const stats = await statsRes.json();
        $$("[data-kpi]").forEach((el) => {
          const k = el.dataset.kpi;
          if (stats[k] != null) el.textContent = stats[k];
        });
      }
      if (ticketsRes.ok) {
        const tickets = await ticketsRes.json();
        const list = Array.isArray(tickets) ? tickets : tickets.tickets || [];
        const ticketList = $("#ticketList");
        if (ticketList) {
          ticketList.innerHTML =
            list.slice(0, 8).map((t) => {
              const id = t.ticket_id || t.id || "—";
              const summary = t.summary || t.title || "—";
              const status = t.status || "";
              const urg = t.urgency || "";
              return `<li><strong>${id}</strong> ${summary}<span class="meta">${urg} · ${status}</span></li>`;
            }).join("") || "<li>暂无工单</li>";
        }
      }
      if (ctRes.ok) {
        const ct = await ctRes.json();
        const prov = ct.province || {};
        const setCt = (k, v) => {
          const el = $(`[data-ct="${k}"]`);
          if (el && v != null && v !== "") el.textContent = v;
        };
        setCt("orders", prov.orders);
        setCt("repeat", prov.repeat);
        setCt("rate", prov.rate != null ? `${prov.rate}%` : "—");
        $("#ctMeta").textContent =
          ct.ok === false ? ct.error || "无数据" : ct.period || ct.source_file || "已更新";
        renderMiniMap(ct);
      }
    } catch (e) {
      $("#ctMeta").textContent = "加载失败";
      console.warn(e);
    }

    try {
      const cap = await fetch("/api/capabilities");
      if (cap.ok) {
        const data = await cap.json();
        const agents = data.subagents || data.agents || [];
        const names = Array.isArray(agents)
          ? agents.map((a) => (typeof a === "string" ? a : a.name)).filter(Boolean)
          : Object.keys(agents);
        $("#capList").innerHTML =
          names.map((n) => `<li>子智能体：${n}</li>`).join("") || "<li>暂无能力信息</li>";
      }
    } catch {
      /* ignore */
    }
  }

  function renderMiniMap(ct) {
    const el = $("#ctMap");
    if (!el || typeof echarts === "undefined") return;
    const rows = [...(ct.cities || [])].sort((a, b) => (b.rate || 0) - (a.rate || 0));
    if (!rows.length) {
      el.innerHTML =
        '<div style="display:grid;place-items:center;height:100%;color:#5c7268;font-size:13px">暂无地图数据</div>';
      return;
    }
    const top = rows.slice(0, 10).reverse();
    const chart = echarts.init(el);
    chart.setOption({
      grid: { left: 48, right: 16, top: 12, bottom: 28 },
      xAxis: { type: "value", axisLabel: { fontSize: 10 }, name: "重投率%" },
      yAxis: {
        type: "category",
        data: top.map((r) => r.name || ""),
        axisLabel: { fontSize: 10 },
      },
      series: [
        {
          type: "bar",
          data: top.map((r) => Number(r.rate || 0)),
          itemStyle: { color: "#1a6b4f" },
        },
      ],
    });
  }

  addBubble("sys", "手机演示页 · 默认可直接对话");
  ping();
  setTab("chat");
})();
