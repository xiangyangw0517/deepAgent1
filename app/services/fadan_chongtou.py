"""从发单服务（可配置 BASE）拉取最新 Excel，解析三节点重投看板数据。

不修改 complaint-agent：只调用已有
  GET {base}/api/v1/fadan/files
  GET {base}/api/v1/fadan/download/{filename}
"""

from __future__ import annotations

import json
import logging
import re
import tempfile
from pathlib import Path
from typing import Any
from urllib.error import HTTPError, URLError
from urllib.request import Request, urlopen

from openpyxl import load_workbook

from app.config import BASE_DIR

logger = logging.getLogger(__name__)

# 与前端共用：frontend/assets/geo/city_to_geo.json
_CITY_MAP_PATH = BASE_DIR / "frontend" / "assets" / "geo" / "city_to_geo.json"


def _load_city_to_geo() -> dict[str, str]:
    try:
        payload = json.loads(_CITY_MAP_PATH.read_text(encoding="utf-8"))
        cities = payload.get("cities") or {}
        aliases = payload.get("aliases") or {}
        return {**cities, **aliases}
    except Exception:
        logger.exception("load city_to_geo.json failed: %s", _CITY_MAP_PATH)
        return {}


CITY_TO_GEO: dict[str, str] = _load_city_to_geo()

_SKIP = {"外省", "全省", "合计", "总计"}
_CT3_HEADER_HINT = 75


def _num(v: Any) -> float:
    if v is None or v == "":
        return 0.0
    if isinstance(v, (int, float)):
        return float(v)
    try:
        return float(str(v).replace("%", "").strip())
    except ValueError:
        return 0.0


def period_label(filename: str) -> str:
    m = re.search(r"fadan_(\d{8})_(\d{8})", filename or "")
    if not m:
        return filename or ""
    a, b = m.group(1), m.group(2)
    return f"{a[:4]}-{a[4:6]}-{a[6:8]} ~ {b[:4]}-{b[4:6]}-{b[6:8]}"


def _http_json(url: str, timeout: float = 30) -> Any:
    req = Request(url, headers={"Accept": "application/json"})
    with urlopen(req, timeout=timeout) as resp:
        return json.loads(resp.read().decode("utf-8", "replace"))


def _http_bytes(url: str, timeout: float = 120) -> bytes:
    req = Request(url)
    with urlopen(req, timeout=timeout) as resp:
        return resp.read()


def pick_latest_fadan_filename(files: list[dict]) -> str | None:
    xs = [
        f
        for f in files
        if str(f.get("filename", "")).startswith("fadan_")
        and str(f.get("filename", "")).endswith(".xlsx")
    ]
    if not xs:
        return None
    xs.sort(key=lambda f: f["filename"], reverse=True)
    return str(xs[0]["filename"])


def parse_chongtou_3node_xlsx(blob: bytes, source_file: str) -> dict:
    """口径：三级工单总量 / 三级重投量 / 三级重投率；另附 total_* 总重投对照。"""
    with tempfile.NamedTemporaryFile(suffix=".xlsx", delete=False) as tmp:
        tmp.write(blob)
        tmp_path = Path(tmp.name)
    try:
        wb = load_workbook(tmp_path, data_only=True, read_only=True)
        if "统计结果" not in wb.sheetnames:
            raise ValueError("缺少 sheet「统计结果」")
        ws = wb["统计结果"]

        header_row = None
        header: list[str] = []
        candidates: list[int] = []
        for i, row in enumerate(ws.iter_rows(min_row=1, max_row=120, max_col=1, values_only=True), start=1):
            if row and row[0] == "地市":
                candidates.append(i)
        # 三节点在六节点之后，取靠后的表头
        for r in sorted(candidates, reverse=True) or [_CT3_HEADER_HINT]:
            vals = [c.value for c in ws[r][:13]]
            names = [str(x).strip() if x is not None else "" for x in vals]
            if names and names[0] == "地市" and "三级工单总量" in names:
                header = names
                header_row = r
                break
        if header_row is None:
            raise ValueError("未找到三节点重投表头（需含三级工单总量）")

        col = {n: i for i, n in enumerate(header) if n}
        for need in ("地市", "三级工单总量", "三级重投量", "三级重投率"):
            if need not in col:
                raise ValueError(f"三节点表缺少列: {need}")

        cities: list[dict] = []
        province: dict | None = None
        for row in ws.iter_rows(
            min_row=header_row + 1, max_row=header_row + 30, max_col=13, values_only=True
        ):
            raw = row[col["地市"]]
            if raw is None or str(raw).strip() == "":
                continue
            name = str(raw).strip()
            item = {
                "name": name,
                "map_name": CITY_TO_GEO.get(
                    name, name if name.endswith(("市", "州")) else f"{name}市"
                ),
                "orders": int(_num(row[col["三级工单总量"]])),
                "repeat": int(_num(row[col["三级重投量"]])),
                "rate": round(_num(row[col["三级重投率"]]), 4),
                "total_orders": int(_num(row[col["工单总量"]])) if "工单总量" in col else 0,
                "total_repeat": int(_num(row[col["重投总量"]])) if "重投总量" in col else 0,
                "total_rate": round(_num(row[col["总重投率"]]), 4) if "总重投率" in col else 0.0,
            }
            if name == "全省":
                province = item
                continue
            if name in _SKIP:
                continue
            cities.append(item)

        if province is None and cities:
            o = sum(c["orders"] for c in cities)
            r = sum(c["repeat"] for c in cities)
            province = {
                "name": "全省",
                "map_name": "湖南省",
                "orders": o,
                "repeat": r,
                "rate": round((r / o * 100) if o else 0.0, 4),
                "total_orders": sum(c["total_orders"] for c in cities),
                "total_repeat": sum(c["total_repeat"] for c in cities),
                "total_rate": 0.0,
            }

        return {
            "ok": True,
            "metric": "三节点",
            "caliber": {
                "orders": "三级工单总量",
                "repeat": "三级重投量",
                "rate": "三级重投率",
                "note": "看板主指标为三级节点；total_* 为同表总重投对照",
            },
            "period": period_label(source_file),
            "source_file": source_file,
            "province": province,
            "cities": cities,
            "city_count": len(cities),
        }
    finally:
        try:
            tmp_path.unlink(missing_ok=True)
        except OSError:
            pass


def fetch_latest_chongtou_3node(base_url: str, timeout: float = 60) -> dict:
    """从可配置发单服务拉取最新 fadan_*.xlsx 并解析。"""
    base = (base_url or "").rstrip("/")
    if not base:
        return {
            "ok": False,
            "error": "未配置 FADAN_API_BASE_URL（测试如 http://127.0.0.1:8002，上线改服务器地址）",
        }

    files_url = f"{base}/api/v1/fadan/files"
    try:
        listed = _http_json(files_url, timeout=min(timeout, 30))
    except HTTPError as e:
        return {"ok": False, "error": f"列出文件失败 {e.code}: {files_url}"}
    except URLError as e:
        return {"ok": False, "error": f"无法连接发单服务 {files_url}: {e.reason}"}
    except Exception as e:
        logger.exception("fadan files")
        return {"ok": False, "error": f"列出文件异常: {e}"}

    files = listed.get("files") if isinstance(listed, dict) else None
    if not isinstance(files, list):
        return {"ok": False, "error": f"files 响应格式异常: {type(listed).__name__}"}

    latest = pick_latest_fadan_filename(files)
    if not latest:
        return {"ok": False, "error": "暂无 fadan_*.xlsx"}

    dl_url = f"{base}/api/v1/fadan/download/{latest}"
    try:
        blob = _http_bytes(dl_url, timeout=timeout)
    except HTTPError as e:
        return {"ok": False, "error": f"下载失败 {e.code}: {latest}"}
    except Exception as e:
        logger.exception("fadan download")
        return {"ok": False, "error": f"下载异常 {latest}: {e}"}

    if len(blob) < 4 or blob[:2] != b"PK":
        return {"ok": False, "error": f"下载内容不是 xlsx: {latest}"}

    try:
        return parse_chongtou_3node_xlsx(blob, source_file=latest)
    except Exception as e:
        logger.exception("parse chongtou 3node")
        return {"ok": False, "error": f"解析失败: {e}", "source_file": latest}
