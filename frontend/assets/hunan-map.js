(() => {
  const GEO_URL = "/assets/geo/hunan.json";
  const CITY_URL = "/assets/geo/city_to_geo.json";

  let cities = null;
  let cityToGeo = null;
  let geoToCity = null;
  let loadPromise = null;
  let registered = false;

  function applyCityPayload(payload) {
    cities = { ...(payload.cities || {}) };
    cityToGeo = { ...cities, ...(payload.aliases || {}) };
    geoToCity = Object.fromEntries(Object.entries(cities).map(([short, full]) => [full, short]));
    // 别名反向也挂上，便于地图标签回落到常用短名
    Object.entries(payload.aliases || {}).forEach(([alias, full]) => {
      if (!geoToCity[full]) geoToCity[full] = alias;
    });
  }

  async function loadCities() {
    if (cities) return cities;
    const res = await fetch(CITY_URL, { cache: "no-store" });
    if (!res.ok) throw new Error("地市映射缺失");
    applyCityPayload(await res.json());
    return cities;
  }

  function toMapName(name) {
    if (!name) return "";
    const key = String(name).trim();
    if (cityToGeo && cityToGeo[key]) return cityToGeo[key];
    if (key.endsWith("市") || key.endsWith("州")) return key;
    return `${key}市`;
  }

  async function ensureMap() {
    if (registered && cities) return true;
    if (!loadPromise) {
      loadPromise = (async () => {
        if (typeof echarts === "undefined") throw new Error("echarts 未加载");
        await loadCities();
        if (!registered) {
          const res = await fetch(GEO_URL, { cache: "no-store" });
          if (!res.ok) throw new Error("湖南地图资源缺失");
          echarts.registerMap("hunan", await res.json());
          registered = true;
        }
        return true;
      })().catch((err) => {
        loadPromise = null;
        throw err;
      });
    }
    return loadPromise;
  }

  window.HunanMap = {
    get cities() {
      return cities || {};
    },
    get cityToGeo() {
      return cityToGeo || {};
    },
    get geoToCity() {
      return geoToCity || {};
    },
    toMapName,
    ensureMap,
    get ready() {
      return registered && !!cities;
    },
  };
})();
