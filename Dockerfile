# 纯离线构建：OFFLINE=1（默认由 compose 传入）
# 要求：基础镜像已在本机；offline/wheels 已备齐；构建时 network=none
ARG PYTHON_IMAGE=python:3.12-slim-bookworm
ARG DOCKER_PLATFORM=linux/amd64
FROM --platform=${DOCKER_PLATFORM} ${PYTHON_IMAGE}

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    PIP_DISABLE_PIP_VERSION_CHECK=1 \
    PIP_NO_CACHE_DIR=1

WORKDIR /app

ARG OFFLINE=1
ARG PIP_INDEX_URL=https://pypi.tuna.tsinghua.edu.cn/simple

# 离线构建禁止 apt（无外网）；slim 镜像已含常用证书
RUN if [ "$OFFLINE" != "1" ]; then \
      apt-get update && apt-get install -y --no-install-recommends ca-certificates \
      && rm -rf /var/lib/apt/lists/* ; \
    fi

COPY requirements.txt .
COPY offline/wheels /wheels

RUN if [ "$OFFLINE" = "1" ]; then \
      pip install --no-index --find-links=/wheels -r requirements.txt ; \
    else \
      pip install -i "$PIP_INDEX_URL" -r requirements.txt ; \
    fi \
 && rm -rf /wheels

COPY app ./app
COPY frontend ./frontend
COPY skills ./skills
COPY config ./config

EXPOSE 9001

CMD ["uvicorn", "app.main:app", "--host", "0.0.0.0", "--port", "9001"]
