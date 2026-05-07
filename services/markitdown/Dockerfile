FROM python:3.12-slim

ENV PIP_NO_CACHE_DIR=1 \
    PIP_DISABLE_PIP_VERSION_CHECK=1 \
    PYTHONUNBUFFERED=1

# ffmpeg/exiftool are pulled in for MarkItDown's audio + image converters.
# Keeping the layer minimal — extend later if EPUB/audio paths need more.
RUN apt-get update \
    && apt-get install -y --no-install-recommends ffmpeg exiftool \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY requirements.txt ./
RUN pip install -r requirements.txt

COPY server.py ./

ENV PORT=8080
EXPOSE 8080
CMD ["uvicorn", "server:app", "--host", "0.0.0.0", "--port", "8080"]
