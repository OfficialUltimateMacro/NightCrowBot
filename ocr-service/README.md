# Nightcrow PP-OCRv4 service

Run this on a **separate Python server** with at least 1 GB RAM and 2 GB disk. Do not run it on the 512 MiB Node Discord bot server.

```bash
python -m venv .venv
. .venv/bin/activate
pip install -r requirements.txt
export OCR_SERVICE_SECRET='use-the-same-secret-as-the-bot'
uvicorn app:app --host 0.0.0.0 --port 8000
```

Set `OCR_SERVICE_URL` to this server's private address and set the same long `OCR_SERVICE_SECRET` in the Node bot and OCR server. Keep the service private behind a firewall or reverse proxy.

PP-OCRv4 reads text only. It cannot identify NSFW images, prove screenshots are genuine, or cover every language perfectly. It rejects unclear screenshots rather than guessing.
