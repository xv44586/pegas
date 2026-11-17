# Pegas ASR Model Service

Pegas treats speech recognition as a replaceable model service. The Control
Plane only depends on the OpenAI-compatible `POST /v1/audio/transcriptions`
contract. The included service wraps Qwen3-ASR's Transformers backend, but any
compatible provider can replace it without changing Conversation or Task
state. vLLM remains an optional upgrade for streaming or higher throughput.

## Start on a GPU host

The default is Qwen3-ASR 0.6B, FP16, bound to the host's loopback interface on
port `18081`:

```bash
cd services/asr
PEGAS_ASR_API_KEY=replace-me docker compose up --build -d
```

The host needs an NVIDIA driver, Docker and NVIDIA Container Toolkit. Change
the model without rebuilding:

```bash
PEGAS_ASR_MODEL=Qwen/Qwen3-ASR-1.7B \
PEGAS_ASR_API_KEY=replace-me \
docker compose up -d
```

If the host cannot reach Hugging Face directly, configure a compatible model
mirror with `PEGAS_ASR_HF_ENDPOINT` (for example, `https://hf-mirror.com`). If
the mirror's Xet path is slow or unavailable, set `PEGAS_ASR_HF_DISABLE_XET=1`
to use ordinary HTTP downloads.

The default base image is portable. A host that already has a compatible
PyTorch 2.8 / CUDA 12.8 image can reuse it without pulling another CUDA stack:

```bash
PEGAS_ASR_BASE_IMAGE=my-local-pytorch-image:latest \
PEGAS_ASR_API_KEY=replace-me \
docker compose up --build -d
```

Do not expose the ASR service port directly to the public Internet. Keep it on
loopback or a private service network.

## Connect Pegas through SSH

When the model runs on `dev-remote`, forward its loopback port to the Pegas
host:

```bash
ssh -N -L 18081:127.0.0.1:18081 dev-remote
```

Then configure the Control Plane:

```bash
PEGAS_SPEECH_PROVIDER=openai-compatible
PEGAS_SPEECH_BASE_URL=http://127.0.0.1:18081/v1
PEGAS_SPEECH_API_KEY=replace-me
PEGAS_SPEECH_MODEL=Qwen/Qwen3-ASR-0.6B
```

## Verify the model contract

```bash
curl http://127.0.0.1:18081/v1/audio/transcriptions \
  -H "Authorization: Bearer replace-me" \
  -F "model=Qwen/Qwen3-ASR-0.6B" \
  -F "file=@sample.wav"
```

The expected response contains a non-empty `text` field. Audio is deleted
after each request. Draft transcription persists nothing; the direct voice
message endpoint persists only the resulting `user.message` and speech
provenance.
