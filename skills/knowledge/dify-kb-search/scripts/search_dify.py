#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
search_dify.py — 检索自建 Dify 知识库（RAG）

OpenClaw / Claude-Skills 兼容技能包 dify-kb-search 的检索脚本。
零第三方依赖（仅 Python 3 标准库），可直接用系统 python3 运行。

用法:
    python3 scripts/search_dify.py "查询内容" [--top-k 4] [--search-method hybrid_search] [--score 0.5]

配置（按优先级）:
    1. 命令行参数 --base-url / --api-key / --dataset-id
    2. 环境变量 DIFY_BASE_URL / DIFY_API_KEY / DIFY_DATASET_ID
    3. 技能包根目录 .env 文件（KEY=VALUE 格式，每行一条）

输出:
    按相关性排序的分段内容，含得分与来源文档名，供模型据此作答。
"""
import argparse
import json
import os
import sys
import urllib.error
import urllib.request

SKILL_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))

DEFAULT_BASE_URL = "http://localhost/v1"
DEFAULT_TOP_K = 4
MAX_CONTENT_CHARS = 4000


def load_dotenv(path):
    """极简 .env 解析：KEY=VALUE 每行一条，支持 # 注释，忽略引号。"""
    env = {}
    if not os.path.isfile(path):
        return env
    with open(path, encoding="utf-8") as f:
        for line in f:
            line = line.strip()
            if not line or line.startswith("#") or "=" not in line:
                continue
            key, _, value = line.partition("=")
            env[key.strip()] = value.strip().strip('"').strip("'")
    return env


def parse_args():
    ap = argparse.ArgumentParser(description="检索 Dify 知识库（RAG）")
    ap.add_argument("query", help="检索查询内容（自然语言问题）")
    ap.add_argument("--top-k", type=int, default=os.environ.get("DIFY_TOP_K", DEFAULT_TOP_K), help="返回结果条数")
    ap.add_argument("--search-method", choices=["semantic_search", "full_text_search", "hybrid_search"],
                    default=os.environ.get("DIFY_SEARCH_METHOD", "hybrid_search"))
    ap.add_argument("--rerank", dest="rerank", action="store_true", default=True,
                    help="启用重排序（默认开启）")
    ap.add_argument("--no-rerank", dest="rerank", action="store_false", help="关闭重排序")
    ap.add_argument("--score", type=float, default=0.5, help="相关性阈值（0~1）")
    ap.add_argument("--base-url", default="", help="Dify API 基址，默认取 .env/环境变量")
    ap.add_argument("--api-key", default="", help="数据集 API 密钥或个人令牌")
    ap.add_argument("--dataset-id", default="", help="数据集 UUID")
    return ap.parse_args()


def main():
    args = parse_args()

    file_env = load_dotenv(os.path.join(SKILL_ROOT, ".env"))
    base_url = (args.base_url or file_env.get("DIFY_BASE_URL") or
                os.environ.get("DIFY_BASE_URL") or DEFAULT_BASE_URL).rstrip("/")
    api_key = args.api_key or file_env.get("DIFY_API_KEY") or os.environ.get("DIFY_API_KEY") or ""
    dataset_id = args.dataset_id or file_env.get("DIFY_DATASET_ID") or os.environ.get("DIFY_DATASET_ID") or ""

    if not api_key:
        print("错误：未配置 DIFY_API_KEY（在技能包根目录 .env 或环境变量中设置）", file=sys.stderr)
        sys.exit(1)
    if not dataset_id:
        print("错误：未配置 DIFY_DATASET_ID（数据集 UUID）", file=sys.stderr)
        sys.exit(1)

    payload = {
        "query": args.query,
        "retrieval_model": {
            "query": args.query,
            "search_method": args.search_method,
            "reranking_enable": args.rerank,
            "top_k": args.top_k,
            "score_threshold_enabled": True,
            "score_threshold": args.score,
        },
    }

    url = f"{base_url}/datasets/{dataset_id}/retrieve"
    req = urllib.request.Request(
        url,
        data=json.dumps(payload).encode("utf-8"),
        headers={
            "Content-Type": "application/json",
            "Authorization": f"Bearer {api_key}",
        },
        method="POST",
    )

    try:
        with urllib.request.urlopen(req, timeout=30) as resp:
            body = json.load(resp)
    except urllib.error.HTTPError as e:
        detail = ""
        try:
            detail = e.read().decode("utf-8", "replace")
        except Exception:
            pass
        print(f"Dify API {e.code}: {detail}", file=sys.stderr)
        sys.exit(1)
    except Exception as e:
        print(f"无法连接 Dify（{url}）: {e}", file=sys.stderr)
        sys.exit(1)

    # 混合检索会返回多于 top_k 的片段：按得分降序并严格截断为前 top_k 条
    records = sorted(body.get("records") or [], key=lambda r: float(r.get("score") or 0), reverse=True)
    records = records[: max(int(args.top_k), 0)]
    if not records:
        print("（无匹配结果）")
        return

    out = []
    for i, r in enumerate(records, 1):
        seg = r.get("segment") or {}
        doc = seg.get("document") or {}
        content = str(seg.get("content") or "")[:MAX_CONTENT_CHARS]
        out.append(
            f"[{i}] 得分 {float(r.get('score') or 0):.4f} | 来源文档: {doc.get('name') or '(未知)'}\n{content}"
        )
    print("\n\n---\n\n".join(out))


if __name__ == "__main__":
    main()