FROM python:3.11-slim

# Minimal system libs opencv-python-headless / onnxruntime need on Debian slim.
RUN apt-get update && apt-get install -y --no-install-recommends \
    libgomp1 \
    libglib2.0-0 \
    libsm6 \
    libxext6 \
    libxrender1 \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

COPY . .

# Downloads the ~182MB InsightFace model pack at build time, so there's no
# first-run delay when the container actually starts.
RUN python3 download_model.py

# Container is only reachable via its published port regardless of bind
# address, so 0.0.0.0 here doesn't widen exposure the way it would for a
# direct install -- that's still controlled by which host port you publish.
ENV APP_HOST=0.0.0.0
ENV APP_PORT=5151

EXPOSE 5151

CMD ["python3", "app.py"]
