#!/usr/bin/env bash
# 离线依赖下载 + Docker 部署（全部在 offline/ 目录管理）
#
# 默认目标：Linux x86_64 / amd64（与 python:3.12-slim-bookworm 容器一致）
# 有网机器：
#   ./offline/setup.sh                        # 下载 Linux amd64 wheel
#   ./offline/setup.sh --with-docker-image    # 再导出 linux/amd64 基础镜像
#   TARGET=local ./offline/setup.sh           # 仅本机架构（Mac 调试用，勿拷 Linux）
#
# 离线机：
#   ./offline/setup.sh load-image
#   ./offline/setup.sh up
#   ./offline/setup.sh venv
#
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

WHEELS_DIR="${WHEELS_DIR:-$ROOT/offline/wheels}"
IMAGES_DIR="${IMAGES_DIR:-$ROOT/offline/images}"
REQ="${REQ:-$ROOT/requirements.txt}"
PY_VER="${PY_VER:-3.12}"
# linux-amd64（默认）| local（本机 pip 默认平台）
TARGET="${TARGET:-linux-amd64}"
PIP_INDEX="${PIP_INDEX:-https://pypi.tuna.tsinghua.edu.cn/simple}"
BASE_IMAGE="${BASE_IMAGE:-python:3.12-slim-bookworm}"
DOCKER_PLATFORM="${DOCKER_PLATFORM:-linux/amd64}"

# manylinux 标签：覆盖常见 glibc 轮子；可用 PLATFORM 覆盖（空格分隔多个）
# 例：PLATFORM="manylinux2014_x86_64 manylinux_2_17_x86_64"
DEFAULT_LINUX_PLATFORMS="manylinux2014_x86_64 manylinux_2_17_x86_64 manylinux_2_28_x86_64"

usage() {
  sed -n '2,16p' "$0"
  cat <<EOF

环境变量：
  TARGET=linux-amd64|local   默认 linux-amd64（给 Linux 服务器 / Docker）
  PY_VER=3.12                目标 Python 小版本（需与镜像一致）
  PLATFORM="tag1 tag2"       覆盖 manylinux 平台标签
  DOCKER_PLATFORM=linux/amd64

产物：
  offline/wheels/     pip 离线包（Linux amd64）
  offline/images/     基础镜像 tar（--with-docker-image）

注意：
  OFFLINE=1 时 Dockerfile 不访问外网，wheels 必须齐全且架构匹配。
  Mac 上务必用默认 TARGET=linux-amd64，不要用 TARGET=local 去给 Linux 部署。
EOF
}

# 3.12 → 312 / cp312
_py_tag() {
  echo "${PY_VER}" | tr -d '.'
}

download_wheels() {
  local with_docker_image=0
  for arg in "$@"; do
    case "$arg" in
      --with-docker-image) with_docker_image=1 ;;
      -h|--help) usage; exit 0 ;;
    esac
  done

  mkdir -p "$WHEELS_DIR"
  # 避免上次本机 wheel 与 Linux wheel 混装
  if [[ "${CLEAN_WHEELS:-1}" == "1" ]] && [[ -d "$WHEELS_DIR" ]]; then
    find "$WHEELS_DIR" -type f ! -name '.gitkeep' -delete 2>/dev/null || true
  fi

  local py_tag abi
  py_tag="$(_py_tag)"
  abi="cp${py_tag}"

  echo "==> 下载 Python 依赖到: $WHEELS_DIR"
  echo "    requirements: $REQ"
  echo "    index: $PIP_INDEX"
  echo "    target: $TARGET  python: $PY_VER  abi: $abi"

  local pip_args=(
    download -r "$REQ" -d "$WHEELS_DIR" -i "$PIP_INDEX"
    --python-version "$PY_VER"
  )

  if [[ "$TARGET" == "local" ]]; then
    echo "    platform: 本机默认（警告：Mac wheel 不能用于 Linux 服务器）"
  else
    # Linux amd64（含 docker linux/amd64）
    local platforms="${PLATFORM:-$DEFAULT_LINUX_PLATFORMS}"
    echo "    platforms: $platforms"
    echo "    only-binary: :all:（交叉下载必须）"
    pip_args+=(
      --implementation cp
      --abi "$abi"
      --only-binary=:all:
    )
    # shellcheck disable=SC2206
    local plat_arr=($platforms)
    local p
    for p in "${plat_arr[@]}"; do
      pip_args+=(--platform "$p")
    done
  fi

  python3 -m pip "${pip_args[@]}"

  # 粗检：不应出现 macOS / win 轮子（TARGET=linux-amd64 时）
  if [[ "$TARGET" != "local" ]]; then
    local bad
    bad="$(ls -1 "$WHEELS_DIR" 2>/dev/null | grep -E 'macosx|win_amd64|win32' || true)"
    if [[ -n "$bad" ]]; then
      echo "错误: wheels 中混入非 Linux 包，请清空后重试：" >&2
      echo "$bad" >&2
      exit 1
    fi
    local linux_n any_n
    linux_n="$(ls -1 "$WHEELS_DIR" 2>/dev/null | grep -cE 'manylinux|linux_x86_64' || true)"
    any_n="$(ls -1 "$WHEELS_DIR" 2>/dev/null | grep -cE 'py3-none-any|py2\.py3-none-any' || true)"
    echo "==> Linux 二进制 wheel: ${linux_n}  纯 Python any: ${any_n}"
  fi

  ( cd "$WHEELS_DIR" && ls -1 > ../wheels-list.txt )
  echo "==> wheel 数量: $(ls -1 "$WHEELS_DIR" | grep -cv '^\.gitkeep$' | tr -d ' ' || echo 0)"
  echo "==> 清单: offline/wheels-list.txt"

  if [[ "$with_docker_image" -eq 1 ]]; then
    if ! command -v docker >/dev/null 2>&1; then
      echo "错误: 未安装 docker，无法导出基础镜像" >&2
      exit 1
    fi
    mkdir -p "$IMAGES_DIR"
    local safe_name out_tar
    safe_name="$(echo "$BASE_IMAGE" | tr '/:' '__')"
    out_tar="$IMAGES_DIR/${safe_name}.tar"
    echo "==> 拉取并导出基础镜像: $BASE_IMAGE ($DOCKER_PLATFORM) -> $out_tar"
    docker pull --platform "$DOCKER_PLATFORM" "$BASE_IMAGE"
    docker save -o "$out_tar" "$BASE_IMAGE"
    ls -lh "$out_tar"
  fi

  cat <<EOF

完成（目标架构: ${TARGET}）。拷到离线 Linux amd64 后：
  ./offline/setup.sh load-image   # 若导出了基础镜像
  ./offline/setup.sh up           # Docker 离线构建启动
EOF
}

load_image() {
  local tar
  tar="$(ls -1 "$IMAGES_DIR"/*.tar 2>/dev/null | head -n1 || true)"
  if [[ -z "$tar" ]]; then
    echo "错误: 未找到 offline/images/*.tar，请先在有网机器执行：" >&2
    echo "  ./offline/setup.sh --with-docker-image" >&2
    exit 1
  fi
  echo "==> docker load -i $tar"
  docker load -i "$tar"
}

compose_up() {
  if [[ ! -f .env ]]; then
    echo "提示: 未找到 .env，可从 .env.example 复制后填写内网地址"
    [[ -f .env.example ]] && cp -n .env.example .env || true
  fi
  if [[ ! -d offline/wheels ]] || [[ -z "$(ls -A offline/wheels 2>/dev/null | grep -v '^\.gitkeep$' || true)" ]]; then
    echo "错误: offline/wheels 为空，请先在有网机器执行 ./offline/setup.sh" >&2
    exit 1
  fi
  if ! docker image inspect "${PYTHON_IMAGE:-python:3.12-slim-bookworm}" >/dev/null 2>&1; then
    echo "错误: 本地没有基础镜像 ${PYTHON_IMAGE:-python:3.12-slim-bookworm}" >&2
    echo "  请先: docker load -i offline/images/*.tar  或  ./offline/setup.sh load-image" >&2
    exit 1
  fi
  echo "==> 纯离线构建启动: docker compose up -d --build"
  docker compose up -d --build
  echo "==> 访问 http://服务器IP:${APP_PORT:-9001} ，日志: docker compose logs -f deepagent"
}

install_venv() {
  python3 -m venv .venv
  # shellcheck disable=SC1091
  source .venv/bin/activate
  pip install --no-index --find-links="$WHEELS_DIR" -r "$REQ"
  echo "==> 完成。启动: uvicorn app.main:app --host 0.0.0.0 --port 9001"
}

cmd="${1:-download}"
case "$cmd" in
  download|"")
    shift || true
    download_wheels "$@"
    ;;
  --with-docker-image|-h|--help)
    download_wheels "$@"
    ;;
  load-image) load_image ;;
  up) compose_up ;;
  venv) install_venv ;;
  *)
    echo "未知命令: $cmd" >&2
    usage
    exit 1
    ;;
esac
