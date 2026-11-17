ARG ASR_BASE_IMAGE=pytorch/pytorch:2.8.0-cuda12.8-cudnn9-runtime
FROM ${ASR_BASE_IMAGE}

WORKDIR /app

RUN env \
    -u HTTP_PROXY -u HTTPS_PROXY -u ALL_PROXY \
    -u http_proxy -u https_proxy -u all_proxy \
    pip install --no-cache-dir \
    "qwen-asr==0.0.6" \
    "fastapi>=0.115,<1" \
    "uvicorn[standard]>=0.30,<1" \
    "python-multipart>=0.0.20,<1"

ENV HTTP_PROXY="" HTTPS_PROXY="" ALL_PROXY="" \
    http_proxy="" https_proxy="" all_proxy=""

COPY server.py /app/server.py

EXPOSE 8000
ENTRYPOINT ["python", "/app/server.py"]
