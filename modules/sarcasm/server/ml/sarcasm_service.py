from pathlib import Path

import joblib
import uvicorn
from fastapi import FastAPI
from pydantic import BaseModel

MODEL_PATH = Path("sarcasm_model.pkl")


class ScoreRequest(BaseModel):
    text: str


class ScoreResponse(BaseModel):
    score: float


app = FastAPI()
model = None


@app.on_event("startup")
def load_model():
    global model
    print(f"[sarcasm_service] Loading model from {MODEL_PATH.resolve()} ...")
    model = joblib.load(MODEL_PATH)
    print("[sarcasm_service] Model loaded.")


@app.get("/health")
def health():
    return {"ok": True}


@app.post("/score", response_model=ScoreResponse)
def score(req: ScoreRequest):
    text = (req.text or "").strip()
    if not text:
        return {"score": 0.0}

    # model is a sklearn Pipeline: tfidf -> logistic regression
    proba = model.predict_proba([text])[0]
    sarcastic_prob = float(proba[1])  # class 1 == sarcastic
    return {"score": sarcastic_prob}


if __name__ == "__main__":
    uvicorn.run(
        "sarcasm_service:app",
        host="127.0.0.1",
        port=8000,
        reload=False,
    )
