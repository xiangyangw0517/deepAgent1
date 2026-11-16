(() => {
  const $ = (sel) => document.querySelector(sel);
  const view = $("#reworkView");
  if (!view) return;

  const REASON_COLORS = ["#4facfe", "#ff7a45", "#ffd66b", "#b37feb", "#73d13d", "#36cfc9", "#ff85c0", "#95de64"];
  const state = {
    year: null,
    month: null,
    city: "全部",
    barMode: "count",
    mapReason: -1,
    payload: null,
    loaded: false,
    insightIdx: 0,
    insights: [],
  };

  let pieChart = null;
  let mapChart = null;
  let trendChart = null;
  let rankChart = null;
  let aiChart = null;
  let mapReady = false;

  const pad = (n) => String(n).padStart(2, "0");
  const keyOf = (y, m) => `${y}-${pad(m)}`;
  const fmt = (n) => Number(n || 0).toLocaleString("zh-CN");

  function regionName() {
    // 含别名（如 湘西 → 湘西土家族苗族自治州），避免筛选后「无数据」
    return (window.HunanMap && (window.HunanMap.cityToGeo || window.HunanMap.cities)) || {};
  }
  function cityByRegion() {
    return (window.HunanMap && window.HunanMap.geoToCity) || {};
  }
  function toMapName(city) {
    if (window.HunanMap && typeof window.HunanMap.toMapName === "function") {
      return window.HunanMap.toMapName(city);
    }
    return regionName()[city] || city;
  }
  function monthsMap() {
    return (state.payload && state.payload.months) || {};
  }
  function cities() {
    return (state.payload && state.payload.cities) || [];
  }
  function reasons() {
    return (state.payload && state.payload.reasons) || [];
  }
  function reasonShort() {
    const list = state.payload && state.payload.reasonShort;
    return list && list.length ? list : reasons();
  }
  function keys() {
    return Object.keys(monthsMap()).filter((k) => /^\d{4}-\d{2}$/.test(k)).sort();
  }
  function years() {
    return [...new Set(keys().map((k) => k.slice(0, 4)))].sort().reverse();
  }

  function monthRows(y, m) {
    const block = monthsMap()[keyOf(y, m)];
    if (!block || !Array.isArray(block.cities)) return null;
    const map = {};
    block.cities.forEach((row) => {
      const counts = (Array.isArray(row.reasons) ? row.reasons : []).map((n) => Math.max(0, Number(n) || 0));
      while (counts.length < reasons().length) counts.push(0);
      const total = row.total != null ? Number(row.total) : counts.reduce((a, b) => a + b, 0);
      map[row.city] = [total, ...counts.slice(0, reasons().length)];
    });
    return Object.keys(map).length ? map : null;
  }

  function prevRows(y, m) {
    return m === 1 ? monthRows(y - 1, 12) : monthRows(y, m - 1);
  }

  function filterRows(rows) {
    if (!rows) return null;
    if (!state.city || state.city === "全部") return rows;
    if (!rows[state.city]) return {};
    return { [state.city]: rows[state.city] };
  }

  function sumProvince(rows) {
    const size = reasons().length + 1;
    const arr = new Array(size).fill(0);
    Object.values(rows || {}).forEach((vals) => vals.forEach((n, i) => {
      arr[i] += n;
    }));
    return arr;
  }

  function cmpHtml(cur, prev) {
    if (prev == null) return '<span class="cmp flat">无对比</span>';
    if (!prev) return '<span class="cmp flat">上月为 0</span>';
    const diff = cur - prev;
    const pct = Math.abs((diff / prev) * 100).toFixed(1);
    const cls = diff > 0 ? "up" : diff < 0 ? "down" : "flat";
    const arrow = diff > 0 ? "▲" : diff < 0 ? "▼" : "—";
    return `<span class="cmp ${cls}">${arrow} ${pct}%</span>`;
  }

  function setCmp(id, html) {
    const el = document.getElementById(id);
    if (!el) return;
    el.outerHTML = html.replace('class="cmp', `id="${id}" class="cmp`);
  }

  function tipBox() {
    return {
      backgroundColor: "#ffffff",
      borderColor: "rgba(31, 111, 214, 0.35)",
      textStyle: { color: "#1f2d3d", fontSize: 12 },
    };
  }

  function shortName(name) {
    const idx = reasons().indexOf(name);
    return idx >= 0 ? (reasonShort()[idx] || name) : name;
  }

  function applyReason(idx) {
    state.mapReason = Number(idx);
    const sel = $("#selReason");
    if (sel) sel.value = String(state.mapReason);
    renderAll();
  }

  function ensureCharts() {
    if (!window.echarts) return;
    if (!pieChart) {
      pieChart = echarts.init($("#chartPie"));
      pieChart.on("click", (p) => {
        const name = p && p.name;
        if (!name) return;
        const idx = reasons().indexOf(name);
        if (idx < 0) return;
        applyReason(state.mapReason === idx ? -1 : idx);
      });
    }
    if (!mapChart) {
      mapChart = echarts.init($("#chartMap"));
      mapChart.on("click", (p) => {
        const city = p.data && p.data.city;
        if (!city) return;
        state.city = state.city === city ? "全部" : city;
        const sel = $("#selCity");
        if (sel) sel.value = state.city;
        renderAll();
      });
    }
    if (!trendChart) trendChart = echarts.init($("#chartTrend"));
    if (!rankChart) rankChart = echarts.init($("#chartRank"));
    if (!aiChart) aiChart = echarts.init($("#chartAI"));
  }

  async function ensureMap() {
    if (mapReady) return mapReady;
    if (!window.HunanMap || !window.echarts) return false;
    try {
      await window.HunanMap.ensureMap();
      mapReady = true;
    } catch {
      mapReady = false;
    }
    return mapReady;
  }

  function forecast(series, n) {
    const pts = series.filter((v) => v != null).map(Number);
    if (pts.length < 2) return null;
    const N = pts.length;
    const xs = pts.map((_, i) => i);
    const mx = xs.reduce((a, b) => a + b, 0) / N;
    const my = pts.reduce((a, b) => a + b, 0) / N;
    let num = 0;
    let den = 0;
    xs.forEach((x, i) => {
      num += (x - mx) * (pts[i] - my);
      den += (x - mx) ** 2;
    });
    const k = den ? num / den : 0;
    const b = my - k * mx;
    return Array.from({ length: n }, (_, j) => Math.max(0, Math.round(k * (N - 1 + j + 1) + b)));
  }

  function nextKey(k) {
    let [y, m] = String(k).split("-").map(Number);
    m += 1;
    if (m > 12) {
      m = 1;
      y += 1;
    }
    return keyOf(y, m);
  }

  function monthKeysChrono() {
    return keys();
  }

  function reasonOffset() {
    return state.mapReason >= 0 ? state.mapReason + 1 : 0;
  }

  function seriesByCity() {
    const idx = reasonOffset();
    return monthKeysChrono().map((k) => {
      const [y, m] = k.split("-").map(Number);
      const rows = monthRows(y, m);
      if (!rows) return null;
      if (state.city === "全部") return sumProvince(rows)[idx];
      return rows[state.city] ? rows[state.city][idx] || 0 : 0;
    });
  }

  function yoyRows(y, m) {
    return monthRows(y - 1, m);
  }

  function cmpYoy(cur, prev) {
    if (prev == null) return '<span class="cmp flat">同比 -</span>';
    if (!prev) return '<span class="cmp flat">同比 -</span>';
    const diff = cur - prev;
    const pct = Math.abs((diff / prev) * 100).toFixed(1);
    const cls = diff > 0 ? "up" : diff < 0 ? "down" : "flat";
    const arrow = diff > 0 ? "▲" : diff < 0 ? "▼" : "—";
    return `<span class="cmp ${cls}">同比 ${arrow}${pct}%</span>`;
  }

  function buildInsights(rows, prov, prevProv, y, m) {
    const list = [];
    const cityList = cities().filter((c) => rows[c]);
    const prevMap = prevRows(y, m);
    /* 1. 风险预警：地市异常上涨 */
    let worst = null;
    cityList.forEach((c) => {
      if (!prevMap || !prevMap[c] || !prevMap[c][0]) return;
      const prev = prevMap[c][0];
      const r = ((rows[c][0] - prev) / prev) * 100;
      if (!worst || r > worst.r) worst = { c, r, v: rows[c][0] };
    });
    if (worst && worst.r > 8) {
      list.push({
        tag: "warning",
        tagText: "⚠️ 风险预警",
        titleClass: "warn",
        title: `${m}月${worst.c}重投量异常上涨`,
        body: `${worst.c}本月重投 <b>${worst.v}</b> 单，环比 <b style="color:#d93025">+${worst.r.toFixed(1)}%</b>，涨幅显著高于全省均值，可优先复盘该地市高发三级节点与超时情况。`,
        ctx: `${worst.c} ${m}月重投量异常`,
      });
    }
    /* 2. 智能洞察：首要原因 */
    const topR = reasons()
      .map((n, i) => ({ n, i, v: prov[1 + i] || 0 }))
      .sort((a, b) => b.v - a.v)[0];
    if (topR) {
      list.push({
        tag: "insight",
        tagText: "💡 智能洞察",
        titleClass: "blue",
        title: `全省「${topR.n}」占比最高`,
        body: `本月该类共 <b>${topR.v}</b> 单，占全省 <b>${prov[0] ? ((topR.v / prov[0]) * 100).toFixed(1) : "0.0"}%</b>，为拉高总量的首因。可按地市拆解「${topR.n}」责任分布。`,
        ctx: `${topR.n} 专项分析`,
      });
    }
    /* 3. 集中度：头部地市（量大≠异常，结合规模看结构） */
    const ranked = cityList.map((c) => ({ c, v: rows[c][0] })).sort((a, b) => b.v - a.v);
    const topC = ranked[0];
    const second = ranked[1];
    if (topC && prov[0]) {
      const share = ((topC.v / prov[0]) * 100).toFixed(1);
      const topReasons = reasons()
        .map((n, i) => ({ n, v: rows[topC.c] ? rows[topC.c][i + 1] || 0 : 0 }))
        .sort((a, b) => b.v - a.v)
        .filter((o) => o.v > 0)
        .slice(0, 2);
      const reasonHint = topReasons.length
        ? `该市 TOP 原因：${topReasons.map((o) => `「${o.n}」${o.v}单`).join("、")}。`
        : "";
      list.push({
        tag: "insight",
        tagText: "📍 集中度",
        titleClass: "blue",
        title: `${topC.c}量居首（占全省 ${share}%），宜看结构非唯量`,
        body: second
          ? `${topC.c}本月 <b>${topC.v}</b> 单、居全省首位（第二名 <b>${second.v}</b> 单）。用户规模较大的地市绝对量通常更高，属规模效应，不单凭占比判异常；建议结合原因构成与环比看是否结构性变差。${reasonHint}`
          : `${topC.c}本月 <b>${topC.v}</b> 单、居全省首位。量大不等同异常，建议下钻原因结构与环比。${reasonHint}`,
        ctx: `${topC.c} 重投构成与原因结构`,
      });
    }
    /* 4. 原因结构集中：TOP2 原因合计偏高 */
    const reasonRank = reasons()
      .map((n, i) => ({ n, v: prov[1 + i] || 0 }))
      .sort((a, b) => b.v - a.v);
    if (prov[0] && reasonRank[0] && reasonRank[1] && reasonRank[0].v > 0) {
      const top2 = reasonRank[0].v + reasonRank[1].v;
      const top2Share = (top2 / prov[0]) * 100;
      if (top2Share >= 40) {
        list.push({
          tag: "insight",
          tagText: "💡 结构集中",
          titleClass: "blue",
          title: `TOP2 原因合计占全省 ${top2Share.toFixed(1)}%`,
          body: `「${reasonRank[0].n}」<b>${reasonRank[0].v}</b> 单 +「${reasonRank[1].n}」<b>${reasonRank[1].v}</b> 单，问题较集中。可优先压降这两类，对各地市拆解责任节点。`,
          ctx: `${reasonRank[0].n}与${reasonRank[1].n} 双因专项`,
        });
      }
    }
    /* 5. 改善亮点：环比降幅最大的地市 */
    let best = null;
    cityList.forEach((c) => {
      if (!prevMap || !prevMap[c] || !prevMap[c][0]) return;
      const prev = prevMap[c][0];
      const cur = rows[c][0] || 0;
      const r = ((cur - prev) / prev) * 100;
      if (r >= 0) return;
      if (!best || r < best.r) best = { c, r, v: cur, prev };
    });
    if (best && best.r <= -5) {
      list.push({
        tag: "insight",
        tagText: "✅ 改善亮点",
        titleClass: "blue",
        title: `${best.c}重投环比下降 ${Math.abs(best.r).toFixed(1)}%`,
        body: `${best.c}本月 <b>${best.v}</b> 单，较上月 <b>${best.prev}</b> 单明显回落。可复盘其压降动作，作为其他地市参考。`,
        ctx: `${best.c} 环比改善复盘`,
      });
    }
    /* 全省环比上升时并入风险预警（不做「建议」卡片） */
    if (prevProv && prevProv[0] > 0) {
      const r = ((prov[0] - prevProv[0]) / prevProv[0]) * 100;
      if (r > 0) {
        list.push({
          tag: "warning",
          tagText: "⚠️ 风险预警",
          titleClass: "warn",
          title: `全省重投总量环比上升 ${r.toFixed(1)}%`,
          body: `本月全省 <b>${prov[0]}</b> 单，较上月增加 <b>${prov[0] - prevProv[0]}</b> 单，需关注增量主要来源地市与原因类型。`,
          ctx: "全省环比上行",
        });
      }
    }
    return list.slice(0, 5);
  }

  function renderInsights() {
    const slide = $("#insSlide");
    const dots = $("#insDots");
    const tip = $("#insTip");
    if (!slide || !dots) return;
    const list = state.insights;
    if (!list.length) {
      slide.innerHTML = `<div class="body">暂无洞察</div>`;
      dots.innerHTML = "";
      return;
    }
    if (state.insightIdx >= list.length) state.insightIdx = 0;
    const item = list[state.insightIdx];
    tip.textContent = `${state.insightIdx + 1}/${list.length} · ${state.year}年${state.month}月`;
    const ask = (item.ctx || item.title || "").replace(/"/g, "&quot;");
    slide.innerHTML = `
      <span class="tag ${item.tag}">${item.tagText}</span>
      <div class="ttl ${item.titleClass}">${item.title}</div>
      <div class="body">${item.body}</div>
      <div class="ops">
        <button type="button" class="op1" data-ask="${ask}">深度分析</button>
        <button type="button" class="op2" id="insOpenReport">查看报告</button>
      </div>`;
    dots.innerHTML = list.map((_, i) => `<i class="${i === state.insightIdx ? "on" : ""}" data-i="${i}"></i>`).join("");
  }

  function renderPie(prov) {
    const total = prov[0] || 0;
    const items = reasons()
      .map((name, i) => ({ name, value: prov[i + 1] || 0, short: shortName(name) }))
      .filter((item) => item.value > 0)
      .sort((a, b) => b.value - a.value);
    pieChart.setOption({
      backgroundColor: "transparent",
      tooltip: {
        trigger: "item",
        ...tipBox(),
        formatter: (p) => {
          const share = total ? ((p.value / total) * 100).toFixed(1) : "0.0";
          return `${p.name}<br/>${fmt(p.value)} 单 · ${share}%`;
        },
      },
      legend: {
        bottom: 0,
        left: "center",
        type: "scroll",
        itemWidth: 8,
        itemHeight: 8,
        textStyle: { color: "#54708a", fontSize: 10 },
        formatter: (name) => {
          const item = items.find((row) => row.name === name);
          if (!item) return shortName(name);
          const share = total ? ((item.value / total) * 100).toFixed(1) : "0.0";
          return `${item.short} ${fmt(item.value)}单 ${share}%`;
        },
      },
      title: {
        text: fmt(total),
        subtext: "重投总量(单)",
        left: "center",
        top: "34%",
        textStyle: { color: "#d48806", fontSize: 22, fontWeight: 700 },
        subtextStyle: { color: "#7a8ea0", fontSize: 11 },
      },
      series: [{
        type: "pie",
        minAngle: 3,
        radius: ["34%", "52%"],
        center: ["50%", "42%"],
        avoidLabelOverlap: true,
        padAngle: 1.2,
        itemStyle: { borderColor: "#ffffff", borderWidth: 2, borderRadius: 3 },
        label: {
          show: true,
          color: "#33475c",
          fontSize: 10,
          fontWeight: 600,
          formatter: (p) => (p.percent < 4 ? "" : `${shortName(p.name)}\n${fmt(p.value)}单\n${p.percent.toFixed(1)}%`),
        },
        labelLine: { length: 8, length2: 8, smooth: true, lineStyle: { color: "rgba(60,100,140,.45)", width: 1 } },
        labelLayout: { hideOverlap: true, moveOverlap: "shiftY" },
        data: items.map((item) => ({
          ...item,
          label: { show: total ? item.value / total >= 0.04 : false },
          labelLine: { show: total ? item.value / total >= 0.04 : false },
        })),
        color: REASON_COLORS,
      }],
    }, true);
  }

  function renderMap(rows) {
    if (!mapChart || !mapReady) return;
    const reasonIdx = state.mapReason;
    const pct = state.barMode === "pct";
    const prov = sumProvince(rows);
    const cityList = cities().filter((city) => rows[city] && toMapName(city));
    const valueOf = (city) => {
      const row = rows[city];
      if (reasonIdx < 0) return pct ? (prov[0] ? Number(((row[0] / prov[0]) * 100).toFixed(1)) : 0) : row[0];
      return pct ? (row[0] ? Number(((row[reasonIdx + 1] / row[0]) * 100).toFixed(1)) : 0) : (row[reasonIdx + 1] || 0);
    };
    const data = cityList.map((city) => ({ name: toMapName(city), value: valueOf(city), city }));
    const only = state.city !== "全部";
    if (only) data.forEach((o) => { if (o.city !== state.city) o.value = null; });
    const maxV = Math.max(0.0001, ...data.filter((item) => item.value != null).map((item) => item.value)) * 1.15;
    const rShort = reasonIdx >= 0 ? (reasonShort()[reasonIdx] || reasons()[reasonIdx]) : null;
    mapChart.setOption({
      backgroundColor: "transparent",
      tooltip: {
        ...tipBox(),
        formatter: (p) => {
          const city = p.data && p.data.city;
          if (!city || !rows[city]) return `${p.name}<br/>无数据`;
          const row = rows[city];
          /* 选定原因时只显示该原因 */
          if (reasonIdx >= 0) {
            const raw = row[reasonIdx + 1] || 0;
            const share = row[0] ? ((raw / row[0]) * 100).toFixed(1) : "0.0";
            const line = pct
              ? `${rShort}：<b style="color:#d48806">${share}%</b>（占当地）`
              : `${rShort}：<b style="color:#1f6fd6">${fmt(raw)}</b> 单`;
            return `<div style="font-weight:700;margin-bottom:4px">${city}</div>${line}`;
          }
          const lines = reasons().map((name, i) => {
            const raw = row[i + 1] || 0;
            const share = row[0] ? ((raw / row[0]) * 100).toFixed(1) : "0.0";
            return pct
              ? `${shortName(name)}：<b style="color:#d48806">${share}%</b>`
              : `${shortName(name)}：<b style="color:#1f6fd6">${fmt(raw)}</b> 单`;
          }).join("<br/>");
          return pct
            ? `<div style="font-weight:700;margin-bottom:4px">${city} · 原因占比</div>${lines}`
            : `<div style="font-weight:700;margin-bottom:4px">${city} · 重投 ${fmt(row[0])} 单</div>${lines}`;
        },
      },
      visualMap: {
        type: "continuous",
        min: 0,
        max: maxV,
        left: 4,
        bottom: 8,
        orient: "vertical",
        itemWidth: 11,
        itemHeight: 110,
        calculable: true,
        text: ["高", "低"],
        textStyle: { color: "#54708a", fontSize: 10 },
        inRange: { color: ["#dbe7f3", "#9cc3e8", "#4f92d0", "#ffb642", "#e5482f"] },
        formatter: (v) => (pct ? `${Number(v).toFixed(1)}%` : Math.round(v)),
      },
      series: [{
        type: "map",
        map: "hunan",
        roam: true,
        selectedMode: false,
        layoutCenter: ["52%", "45%"],
        layoutSize: "94%",
        scaleLimit: { min: 0.7, max: 3 },
        label: {
          show: true,
          color: "#2c3e50",
          fontSize: 10.5,
          fontWeight: 600,
          formatter: (p) => cityByRegion()[p.name] || p.name,
        },
        itemStyle: {
          borderColor: "#ffffff",
          borderWidth: 1,
          areaColor: "#e9eef3",
          shadowColor: "rgba(30,60,100,.18)",
          shadowBlur: 8,
        },
        emphasis: {
          label: { color: "#1f2d3d", fontWeight: 700 },
          itemStyle: { areaColor: "#ffd66b", shadowBlur: 16, shadowColor: "rgba(255,182,66,.5)" },
        },
        data,
      }],
    }, true);
  }

  function renderTrend() {
    const ks = monthKeysChrono();
    const hist = seriesByCity();
    const fc = forecast(hist.filter((v) => v != null).slice(-6), 1) || [0];
    const lastKey = ks[ks.length - 1];
    const nx = lastKey ? nextKey(lastKey) : null;
    const cats = nx ? [...ks, nx] : ks.slice();
    const hData = hist.map((v, i) => [ks[i], v]);
    const last = hist[hist.length - 1];
    const fData = lastKey && nx != null ? [[lastKey, last], [nx, fc[0]]] : [];
    const valid = hist.filter((v) => v != null);
    const avg = valid.length ? Math.round(valid.reduce((a, b) => a + b, 0) / valid.length) : 0;
    const up = fc[0] >= (last || 0);
    trendChart.setOption({
      backgroundColor: "transparent",
      tooltip: { trigger: "axis", ...tipBox() },
      legend: { top: 4, right: 12, textStyle: { color: "#54708a", fontSize: 11 } },
      grid: { left: 52, right: 26, top: 42, bottom: 30 },
      xAxis: {
        type: "category",
        data: cats,
        boundaryGap: false,
        axisLabel: { color: "#54708a", fontSize: 10.5, formatter: (v) => String(v).slice(5) + "月" },
        axisTick: { show: false },
      },
      yAxis: {
        type: "value",
        name: "单量",
        nameTextStyle: { color: "#8296a8", fontSize: 10 },
        axisLabel: { color: "#54708a", fontSize: 10.5 },
        splitLine: { lineStyle: { color: "rgba(30,70,110,.08)" } },
      },
      series: [
        {
          name: "重投总量",
          type: "line",
          data: hData,
          smooth: true,
          symbol: "circle",
          symbolSize: 6,
          connectNulls: false,
          lineStyle: { width: 2.6, color: "#1f6fd6" },
          itemStyle: { color: "#1f6fd6", borderColor: "#fff", borderWidth: 2 },
          areaStyle: {
            color: {
              type: "linear",
              x: 0,
              y: 0,
              x2: 0,
              y2: 1,
              colorStops: [
                { offset: 0, color: "rgba(31,111,214,.20)" },
                { offset: 1, color: "rgba(31,111,214,.01)" },
              ],
            },
          },
          markLine: avg
            ? {
                silent: true,
                symbol: "none",
                lineStyle: { color: "rgba(212,136,6,.5)", type: "dashed" },
                label: { color: "#b26a00", fontSize: 10, formatter: "月均 {c}" },
                data: [{ yAxis: avg }],
              }
            : undefined,
        },
        {
          name: "AI预测",
          type: "line",
          data: fData,
          smooth: true,
          symbol: "circle",
          symbolSize: 8,
          lineStyle: {
            width: 2.4,
            type: "dashed",
            color: up ? "#e5482f" : "#0f8a4d",
          },
          itemStyle: {
            color: up ? "#e5482f" : "#0f8a4d",
            borderColor: "#fff",
            borderWidth: 2,
          },
          label: {
            show: true,
            color: up ? "#d93025" : "#0f8a4d",
            fontWeight: 800,
            fontSize: 11,
            position: "top",
            formatter: (p) => (p.dataIndex === 1 ? `AI预测：${Array.isArray(p.data) ? p.data[1] : p.value}单` : ""),
          },
        },
      ],
    }, true);
  }

  function renderRank(rows) {
    let cats;
    let vals;
    const idx = reasonOffset();
    if (state.city === "全部") {
      const arr = cities().filter((c) => rows[c]).map((c) => ({ c, v: rows[c][idx] || 0 })).sort((a, b) => b.v - a.v);
      cats = arr.map((o) => o.c);
      vals = arr.map((o) => o.v);
    } else if (state.mapReason >= 0) {
      cats = [shortName(reasons()[state.mapReason] || "")];
      vals = [rows[state.city] ? rows[state.city][idx] || 0 : 0];
    } else {
      const raw = reasons().map((name, i) => ({ name: shortName(name), v: rows[state.city] ? rows[state.city][i + 1] || 0 : 0 }));
      raw.sort((a, b) => b.v - a.v);
      cats = raw.map((o) => o.name);
      vals = raw.map((o) => o.v);
    }
    const showN = state.city === "全部" ? 7 : 8;
    const scrollable = cats.length > showN;
    rankChart.setOption({
      backgroundColor: "transparent",
      tooltip: { ...tipBox(), trigger: "axis", axisPointer: { type: "shadow" } },
      grid: { left: 76, right: 96, top: scrollable ? 26 : 16, bottom: 20 },
      dataZoom: scrollable
        ? [{
            type: "inside",
            yAxisIndex: 0,
            filterMode: "empty",
            startValue: 0,
            endValue: showN - 1,
            zoomOnMouseWheel: false,
            moveOnMouseWheel: true,
            moveOnMouseMove: true,
          }]
        : [],
      graphic: scrollable
        ? [{
            type: "text",
            left: 90,
            top: 8,
            style: { text: "🖱 鼠标滚轮上下滑动查看全部", fill: "#8296a8", fontSize: 10.5 },
          }]
        : [],
      xAxis: {
        type: "value",
        // 轴上限略放大，条形整体视觉收短，右侧留白更舒服
        max: (extent) => {
          const m = Math.max(1, Number(extent.max) || 0);
          return Math.ceil(m * 1.35);
        },
        axisLabel: { color: "#54708a", fontSize: 10.5 },
        splitLine: { lineStyle: { color: "rgba(30,70,110,.08)" } },
      },
      yAxis: {
        type: "category",
        data: cats,
        inverse: true,
        axisLine: { show: false },
        axisTick: { show: false },
        axisLabel: { color: "#33475c", fontSize: 11.5 },
      },
      series: [{
        type: "bar",
        data: vals,
        barWidth: "56%",
        label: {
          show: true,
          position: "right",
          distance: 5,
          color: "#54708a",
          fontWeight: 600,
          fontSize: 10.5,
          formatter: (p) => `${fmt(p.value)} 单`,
        },
        itemStyle: {
          borderRadius: [0, 6, 6, 0],
          color: {
            type: "linear",
            x: 0,
            y: 0,
            x2: 1,
            y2: 0,
            colorStops: [
              { offset: 0, color: "#d7e6f5" },
              { offset: 1, color: "#7eabd6" },
            ],
          },
        },
      }],
    }, true);
  }

  function renderAI() {
    const ks = monthKeysChrono();
    const hist = seriesByCity();
    const valid = hist.filter((v) => v != null);
    const fc = forecast(valid.slice(-6), 2) || [valid[valid.length - 1] || 0, valid[valid.length - 1] || 0];
    const last = valid[valid.length - 1] || 0;
    const up = fc[0] >= last;
    const lastKey = ks[ks.length - 1];
    const n1 = lastKey ? nextKey(lastKey) : "下月";
    const n2 = lastKey ? nextKey(n1) : "下下月";
    $("#aiNum").textContent = `${fmt(fc[0])} 单`;
    $("#aiNum").style.color = up ? "#d93025" : "#0f8a4d";
    $("#aiNote").textContent = `预估 ${n1} 重投量 · ${up ? "↑ 上升" : "↓ 回落"}`;
    const x = [...ks, n1, n2];
    const hData = hist.map((v, i) => [ks[i], v]);
    hData.push([n1, last]);
    const fData = [[lastKey, last], [n1, fc[0]], [n2, fc[1]]];
    aiChart.setOption({
      backgroundColor: "transparent",
      grid: { left: 8, right: 8, top: 12, bottom: 6 },
      xAxis: { type: "category", data: x, show: false },
      yAxis: { type: "value", show: false },
      series: [
        {
          type: "line",
          data: hData,
          symbol: "none",
          smooth: true,
          lineStyle: { width: 2, color: "#1f6fd6" },
          areaStyle: {
            color: {
              type: "linear",
              x: 0,
              y: 0,
              x2: 0,
              y2: 1,
              colorStops: [
                { offset: 0, color: "rgba(31,111,214,.22)" },
                { offset: 1, color: "rgba(31,111,214,0)" },
              ],
            },
          },
        },
        {
          type: "line",
          data: fData,
          smooth: true,
          symbol: "circle",
          symbolSize: 6,
          lineStyle: { width: 2, type: "dashed", color: up ? "#e5482f" : "#0f8a4d" },
          itemStyle: {
            color: up ? "#e5482f" : "#0f8a4d",
            shadowColor: up ? "rgba(229,72,47,.55)" : "rgba(15,138,77,.55)",
            shadowBlur: 8,
          },
        },
      ],
    }, true);
  }

  function renderTable(rows, y, m) {
    const names = reasons();
    const prev = prevRows(y, m);
    const yoy = yoyRows(y, m);
    const list = cities().filter((city) => rows[city]).sort((a, b) => rows[b][0] - rows[a][0]);
    const maxOf = names.map((_, i) => Math.max(0, ...list.map((city) => rows[city][i + 1] || 0)));
    $("#detailHead").innerHTML = `<tr><th class="l">地市</th><th>重投总量</th><th>环比</th><th>同比</th>${names.map((name) => `<th>${name}</th>`).join("")}</tr>`;
    const body = list.map((city) => {
      const row = rows[city];
      const before = prev && prev[city] ? prev[city][0] : null;
      const lastYear = yoy && yoy[city] ? yoy[city][0] : null;
      return `<tr><td class="l" style="font-weight:600">${city}</td><td style="color:#b26a00;font-weight:700">${fmt(row[0])}</td><td>${cmpHtml(row[0], before)}</td><td>${cmpYoy(row[0], lastYear)}</td>${names.map((_, i) => {
        const value = row[i + 1] || 0;
        const cls = value === 0 ? "zero" : (value >= 2 && value === maxOf[i] ? "top" : "");
        return `<td class="${cls}">${value}</td>`;
      }).join("")}</tr>`;
    }).join("");
    const prov = sumProvince(rows);
    const prevProv = prev ? sumProvince(prev) : null;
    const yoyProv = yoy ? sumProvince(yoy) : null;
    $("#detailBody").innerHTML = `${body}<tr class="sum"><td class="l">全省</td><td>${fmt(prov[0])}</td><td>${cmpHtml(prov[0], prevProv ? prevProv[0] : null)}</td><td>${cmpYoy(prov[0], yoyProv ? yoyProv[0] : null)}</td>${names.map((_, i) => `<td>${prov[i + 1] || 0}</td>`).join("")}</tr>`;
    $("#detailMeta").textContent = `${y}年${m}月 · 单位：单 · 派单时间口径 · 含环比/同比`;
  }

  async function renderAll() {
    const raw = monthRows(state.year, state.month);
    if (!raw) {
      $("#liveBadge").textContent = state.loaded ? "暂无月份数据" : "读取中…";
      $("#liveBadge").className = "badge demo";
      return;
    }
    ensureCharts();
    await ensureMap();
    const rows = filterRows(raw);
    const full = raw;
    const prov = sumProvince(rows);
    const prevFull = prevRows(state.year, state.month);
    const prev = prevFull ? filterRows(prevFull) : null;
    const prevProv = prev ? sumProvince(prev) : null;

    const metricIdx = reasonOffset();
    $("#kTotal").textContent = fmt(prov[metricIdx]);
    $("#kSpan").textContent = state.mapReason >= 0
      ? `${state.city === "全部" ? "全省" : state.city} · ${reasonShort()[state.mapReason] || reasons()[state.mapReason]}`
      : (state.city === "全部" ? "全省" : state.city);
    setCmp("kTotalCmp", cmpHtml(prov[metricIdx], prevProv ? prevProv[metricIdx] : null));

    const rank = reasons()
      .map((name, i) => ({ name, i, value: prov[i + 1] || 0 }))
      .sort((a, b) => b.value - a.value);
    [["k1v", "k1n", "k1c"], ["k2v", "k2n", "k2c"], ["k3v", "k3n", "k3c"]].forEach(([v, n, c], idx) => {
      const item = rank[idx];
      document.getElementById(v).textContent = item ? fmt(item.value) : "—";
      document.getElementById(n).textContent = item ? (reasonShort()[item.i] || item.name) : "—";
      setCmp(c, item ? cmpHtml(item.value, prevProv ? prevProv[item.i + 1] : null) : '<span class="cmp flat">—</span>');
    });

    $("#pieTip").textContent = `${state.city === "全部" ? "全省" : state.city} ${fmt(prov[0])} 单 · ${state.year}年${state.month}月`;
    const mapTip = $("#chartMap")?.closest(".card")?.querySelector(".card-h .tip");
    if (mapTip) {
      mapTip.textContent = state.mapReason >= 0
        ? `仅看「${reasonShort()[state.mapReason] || reasons()[state.mapReason]}」`
        : "可缩放 · 按原因筛选";
    }
    const meta = (state.payload && state.payload.meta) || {};
    $("#liveBadge").className = "badge";
    $("#liveBadge").textContent = meta.updatedAt ? `已同步 · ${meta.updatedAt}` : "已同步 · 派单时间";

    state.insights = buildInsights(full, sumProvince(full), prevFull ? sumProvince(prevFull) : null, state.year, state.month);
    renderInsights();
    renderPie(prov);
    renderMap(full);
    renderTrend();
    renderRank(full);
    renderAI();
    renderTable(full, state.year, state.month);
    requestAnimationFrame(resizeCharts);
  }

  function fillSelect(sel, html) {
    if (!sel) return;
    // 选项集合不变则只同步选中值，避免刷新闪烁
    if (sel.dataset.opts === html) return;
    sel.innerHTML = html;
    sel.dataset.opts = html;
  }

  function buildFilters() {
    const list = years();
    const yearSel = $("#selYear");
    const monthSel = $("#selMonth");
    const citySel = $("#selCity");
    if (!list.length) {
      fillSelect(yearSel, "<option>暂无年份</option>");
      fillSelect(monthSel, "");
      fillSelect(citySel, "<option>全部</option>");
      return;
    }
    if (!list.includes(String(state.year))) state.year = Number(list[0]);
    const months = keys().filter((k) => k.startsWith(`${state.year}-`)).map((k) => Number(k.slice(5)));
    if (!months.includes(state.month)) state.month = Math.max(...months);
    const cityOpts = ["全部", ...cities()];
    if (!cityOpts.includes(state.city)) state.city = "全部";
    fillSelect(yearSel, list.map((y) => `<option value="${y}">${y} 年</option>`).join(""));
    fillSelect(monthSel, months.map((m) => `<option value="${m}">${m} 月</option>`).join(""));
    fillSelect(citySel, cityOpts.map((c) => `<option value="${c}">${c}</option>`).join(""));
    yearSel.value = String(state.year);
    monthSel.value = String(state.month);
    citySel.value = state.city;
  }

  function buildReasonSelect() {
    const sel = $("#selReason");
    if (!sel) return;
    const list = reasons();
    const shorts = reasonShort();
    sel.innerHTML = `<option value="-1">全部原因</option>` + list.map((name, i) =>
      `<option value="${i}" title="${name}">${shorts[i] || name}</option>`
    ).join("");
    sel.value = String(state.mapReason);
  }

  async function load({ soft = false, resetCity = false } = {}) {
    if (resetCity) state.city = "全部";
    if (!soft || !state.loaded) {
      $("#liveBadge").textContent = "读取中…";
      $("#liveBadge").className = "badge demo";
    } else {
      $("#liveBadge").textContent = "同步中…";
    }
    try {
      const res = await fetch("/api/dashboard/rework", { cache: "no-store" });
      if (!res.ok) throw new Error("bad status");
      const next = await res.json();
      state.payload = next;
      state.loaded = true;
      const latest = keys().at(-1);
      if (latest && (state.year == null || state.month == null)) {
        const [y, m] = latest.split("-").map(Number);
        state.year = y;
        state.month = m;
      } else if (latest) {
        // 保持当前年月；若当前月已不存在则回落到最新
        if (!monthsMap()[keyOf(state.year, state.month)]) {
          const [y, m] = latest.split("-").map(Number);
          state.year = y;
          state.month = m;
        }
      }
      buildFilters();
      buildReasonSelect();
      await renderAll();
    } catch {
      state.loaded = true;
      if (!state.payload) state.payload = { months: {} };
      buildFilters();
      buildReasonSelect();
      $("#liveBadge").textContent = "看板接口暂不可用";
      $("#liveBadge").className = "badge demo";
    }
  }

  function resizeCharts() {
    [pieChart, mapChart, trendChart, rankChart, aiChart].forEach((c) => c && c.resize());
  }

  async function downloadExport(params) {
    const qs = new URLSearchParams(params);
    const res = await fetch(`/api/dashboard/rework/export?${qs}`);
    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      throw new Error(err.detail || `导出失败 HTTP ${res.status}`);
    }
    const rowCount = Number(res.headers.get("X-Export-Rows") || "0");
    const blob = await res.blob();
    if (!rowCount) {
      throw new Error("该派单时间范围内无三节点重投数据，请调整起止日期后重试");
    }
    const cd = res.headers.get("Content-Disposition") || "";
    const m = /filename=\"?([^\";]+)\"?/i.exec(cd);
    const name = m ? m[1] : "rework_export.csv";
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = name;
    a.click();
    URL.revokeObjectURL(url);
  }

  function fillCustomExportDates() {
    const y = state.year;
    const m = state.month;
    if (!y || !m) return;
    const pad = (n) => String(n).padStart(2, "0");
    const last = new Date(y, m, 0).getDate();
    const startEl = $("#expStart");
    const endEl = $("#expEnd");
    if (startEl) startEl.value = `${y}-${pad(m)}-01`;
    if (endEl) endEl.value = `${y}-${pad(m)}-${pad(last)}`;
  }

  function closeExportMenu() {
    $("#exportMenu")?.classList.remove("on");
  }

  async function openReport() {
    if (!state.year || !state.month) {
      alert("请先选择有数据的年月");
      return;
    }
    $("#reportMeta").textContent = "正在生成…";
    $("#reportBody").innerHTML = `<p style="padding:24px;color:#54708a">正在按派单时间聚合 ${state.year}-${pad(state.month)}…</p>`;
    $("#reportDrawer").classList.add("on");
    $("#reportBackdrop").classList.add("on");
    try {
      const res = await fetch("/api/dashboard/rework/report", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ year: state.year, month: state.month }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.detail || `HTTP ${res.status}`);
      $("#reportMeta").textContent = data.period?.label || `${state.year}-${pad(state.month)}`;
      const html = data.html || "";
      $("#reportBody").dataset.html = html;
      $("#reportBody").innerHTML = html
        ? `<iframe title="月度报告" class="report-frame" srcdoc="${html.replaceAll("&", "&amp;").replaceAll('"', "&quot;")}"></iframe>`
        : `<p style="padding:24px">报告为空</p>`;
    } catch (err) {
      $("#reportMeta").textContent = "生成失败";
      $("#reportBody").innerHTML = `<p style="padding:24px;color:#d93025">${String(err.message || err)}</p>`;
    }
  }

  function closeReport() {
    $("#reportDrawer")?.classList.remove("on");
    $("#reportBackdrop")?.classList.remove("on");
  }

  function openDetail() {
    $("#detail").classList.add("on");
    $("#detailBackdrop").classList.add("on");
  }
  function closeDetail() {
    $("#detail").classList.remove("on");
    $("#detailBackdrop").classList.remove("on");
  }

  $("#btnRefresh").addEventListener("click", () => load({ soft: true, resetCity: true }));
  window.addEventListener("rework:refresh", () => load({ soft: true }));
  $("#selYear").addEventListener("change", async (e) => {
    state.year = Number(e.target.value);
    buildFilters();
    await renderAll();
  });
  $("#selMonth").addEventListener("change", async (e) => {
    state.month = Number(e.target.value);
    await renderAll();
  });
  $("#selCity").addEventListener("change", async (e) => {
    state.city = e.target.value;
    await renderAll();
  });
  $("#selReason").addEventListener("change", (e) => {
    applyReason(Number(e.target.value));
  });
  $("#mapSeg").addEventListener("click", (e) => {
    const btn = e.target.closest("button.seg");
    if (!btn) return;
    state.barMode = btn.dataset.mode;
    [...e.currentTarget.querySelectorAll(".seg")].forEach((el) => el.classList.toggle("on", el === btn));
    const rows = monthRows(state.year, state.month);
    if (rows && mapChart) renderMap(rows);
  });

  document.querySelector(".tabs")?.addEventListener("click", (e) => {
    const tab = e.target.closest(".tab");
    if (!tab) return;
    document.querySelectorAll(".tabs .tab").forEach((el) => el.classList.toggle("on", el === tab));
    document.querySelectorAll(".row3 .pane").forEach((pane) => {
      pane.classList.toggle("on", pane.id === `pane-${tab.dataset.tab}`);
    });
    requestAnimationFrame(resizeCharts);
  });

  $("#insDots")?.addEventListener("click", (e) => {
    const i = e.target.closest("i[data-i]");
    if (!i) return;
    state.insightIdx = Number(i.dataset.i);
    renderInsights();
  });
  $("#insSlide")?.addEventListener("click", (e) => {
    if (e.target.id === "insOpenReport" || e.target.closest("#insOpenReport")) {
      openReport();
      return;
    }
    const ask = e.target.closest("[data-ask]");
    if (ask) {
      const prompt = `请基于${state.year}年${state.month}月看板数据做深度分析：${ask.dataset.ask}`;
      if (window.agentDock && typeof window.agentDock.open === "function") {
        window.agentDock.open({ prompt });
      } else {
        const input = $("#messageInput");
        if (input) input.value = prompt;
        $("#agentFab")?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
      }
    }
  });

  $("#btnExport")?.addEventListener("click", (e) => {
    e.stopPropagation();
    $("#exportMenu")?.classList.toggle("on");
  });
  document.addEventListener("click", () => closeExportMenu());
  $("#exportMenu")?.addEventListener("click", async (e) => {
    const btn = e.target.closest("button[data-scope]");
    if (!btn) return;
    e.stopPropagation();
    closeExportMenu();
    try {
      if (btn.dataset.scope === "month") {
        await downloadExport({ year: state.year, month: state.month });
      } else if (btn.dataset.scope === "year") {
        await downloadExport({ start: `${state.year}-01-01`, end: `${state.year}-12-31` });
      } else {
        fillCustomExportDates();
        $("#exportModal")?.classList.add("on");
      }
    } catch (err) {
      alert(String(err.message || err));
    }
  });
  $("#expCancel")?.addEventListener("click", () => $("#exportModal")?.classList.remove("on"));
  $("#expConfirm")?.addEventListener("click", async () => {
    try {
      const start = ($("#expStart")?.value || "").trim();
      const end = ($("#expEnd")?.value || "").trim();
      if (!start || !end) throw new Error("请选择开始与结束日期（派单时间）");
      if (end < start) throw new Error("结束日期不能早于开始日期");
      await downloadExport({ start, end });
      $("#exportModal")?.classList.remove("on");
    } catch (err) {
      alert(String(err.message || err));
    }
  });

  $("#reportClose")?.addEventListener("click", closeReport);
  $("#reportBackdrop")?.addEventListener("click", closeReport);
  $("#btnReportPdf")?.addEventListener("click", () => {
    const html = $("#reportBody")?.dataset?.html;
    if (!html) return;
    const w = window.open("", "_blank");
    if (!w) return alert("请允许弹窗后重试");
    w.document.open();
    w.document.write(html);
    w.document.close();
    setTimeout(() => w.print(), 300);
  });

  $("#btnDetail")?.addEventListener("click", openDetail);
  $("#detailClose")?.addEventListener("click", closeDetail);
  $("#detailBackdrop")?.addEventListener("click", closeDetail);

  document.addEventListener("keydown", (e) => {
    if (e.key !== "Escape") return;
    if ($("#detail")?.classList.contains("on")) closeDetail();
    else if ($("#reportDrawer")?.classList.contains("on")) closeReport();
    else if ($("#exportModal")?.classList.contains("on")) $("#exportModal").classList.remove("on");
  });

  window.addEventListener("resize", resizeCharts);
  setInterval(() => {
    if (state.insights.length > 1) {
      state.insightIdx = (state.insightIdx + 1) % state.insights.length;
      renderInsights();
    }
  }, 8000);

  load();
})();
