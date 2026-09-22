"""Private PP-OCRv4 service for Nightcrow subscription screenshots."""

import io
import os
import re
import unicodedata

import requests
from fastapi import FastAPI, Header, HTTPException
from PIL import Image
from pydantic import BaseModel, HttpUrl
from paddleocr import PaddleOCR

SECRET = os.environ.get("OCR_SERVICE_SECRET")
if not SECRET:
    raise RuntimeError("OCR_SERVICE_SECRET must be set")

app = FastAPI(docs_url=None, redoc_url=None)
# PP-OCRv4's mobile model is used to keep CPU/RAM requirements as low as practical.
ocr = PaddleOCR(use_angle_cls=True, lang="en", ocr_version="PP-OCRv4", show_log=False)

class Proof(BaseModel):
    image_url: HttpUrl

def normalized(value: str) -> str:
    return "".join(char for char in unicodedata.normalize("NFKD", value).lower()
                   if not unicodedata.combining(char))

CHANNEL_TERMS = ("nightcrow", "night crow", "rblxnightcrowstudios")
# Localized labels for an already-subscribed state. The intended channel title remains English.
SUBSCRIBED_TERMS = (
    "subscribed", "suscrito", "abonne", "abonniert", "inscrito", "iscritto",
    "geabonneerd", "zasubskrybowano", "abone olundu", "da dang ky", "berlangganan",
    "подписаны", "已订阅", "登録済み", "구독중", "مشترك", "सदस्यता ली",
)
# Reject a visible action to subscribe, even if other unrelated OCR text looks promising.
SUBSCRIBE_ACTIONS = (
    "subscribe", "suscribirse", "s'abonner", "abonnieren", "inscrever-se",
    "iscriviti", "abonneer", "subskrybuj", "подписаться", "订阅", "登録", "구독",
    "اشتراك", "सदस्यता लें",
)

def contains(text: str, terms: tuple[str, ...]) -> bool:
    return any(term in text for term in terms)

@app.get("/health")
def health():
    return {"ok": True}

@app.post("/review")
def review(proof: Proof, x_nightcrow_secret: str = Header(default="")):
    if x_nightcrow_secret != SECRET:
        raise HTTPException(status_code=401, detail="Unauthorized")
    url = str(proof.image_url)
    if not re.match(r"^https://(cdn|media)\.discordapp\.(com|net)/", url):
        raise HTTPException(status_code=400, detail="Only Discord attachment URLs are accepted")
    response = requests.get(url, timeout=12)
    response.raise_for_status()
    if len(response.content) > 10 * 1024 * 1024:
        raise HTTPException(status_code=413, detail="Image too large")
    image = Image.open(io.BytesIO(response.content)).convert("RGB")
    # PaddleOCR 2.9.1 accepts encoded image bytes, not a PIL Image object.
    result = ocr.ocr(response.content, cls=True)
    lines = result[0] if result else []
    raw = " ".join(item[1][0] for item in lines if item and item[1] and item[1][1] >= 0.65)
    text = normalized(raw)
    if not contains(text, CHANNEL_TERMS):
        return {"accepted": False, "reason": "Nightcrow Studios was not readable in the screenshot."}
    if contains(text, SUBSCRIBE_ACTIONS) or not contains(text, SUBSCRIBED_TERMS):
        return {"accepted": False, "reason": "A visible subscribed state was not readable."}
    return {"accepted": True, "reason": "Nightcrow and a subscribed state were read locally."}


if __name__ == "__main__":
    import uvicorn

    uvicorn.run(app, host="0.0.0.0", port=int(os.environ.get("PORT", "25968")))
