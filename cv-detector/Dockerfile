# PrijelazRadar CV detector — YOLO vehicle counting microservice.
FROM python:3.11-slim

# OpenCV / ultralytics runtime deps.
RUN apt-get update && apt-get install -y --no-install-recommends \
    libgl1 libglib2.0-0 \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

# Pre-download the default model into the image layer so the first request is fast.
ARG CV_MODEL=yolov8n.pt
RUN python -c "from ultralytics import YOLO; YOLO('${CV_MODEL}')"

COPY app.py .

ENV CV_MODEL=${CV_MODEL}
EXPOSE 8000
CMD ["uvicorn", "app:app", "--host", "0.0.0.0", "--port", "8000"]
