import time
from pathlib import Path

import joblib
import pandas as pd
from sklearn.feature_extraction.text import TfidfVectorizer
from sklearn.linear_model import LogisticRegression
from sklearn.metrics import classification_report
from sklearn.model_selection import train_test_split
from sklearn.pipeline import Pipeline

DATA_DIR = Path("data")
TRAIN_PATH = DATA_DIR / "kaggle_train.csv"
MODEL_PATH = Path("sarcasm_model.pkl")

TEXT_COL = "comment"  # from your inspection
LABEL_COL = "label"   # 0 = normal, 1 = sarcastic


def load_data():
    if not TRAIN_PATH.exists():
        raise FileNotFoundError(f"Train CSV not found: {TRAIN_PATH.resolve()}")

    print(f"[train] Loading {TRAIN_PATH.name} ...")
    df = pd.read_csv(TRAIN_PATH)
    print(f"[train] Columns: {list(df.columns)}")

    if TEXT_COL not in df.columns or LABEL_COL not in df.columns:
        raise ValueError(
            f"Expected columns {TEXT_COL!r} and {LABEL_COL!r}, "
            f"but got {list(df.columns)}"
        )

    df = df[[TEXT_COL, LABEL_COL]].dropna()

    X = df[TEXT_COL].astype(str)
    y = df[LABEL_COL].astype(int)
    return X, y


def build_pipeline():
    return Pipeline([
        (
            "tfidf",
            TfidfVectorizer(
                ngram_range=(1, 2),
                max_features=50000,
                min_df=3,
            ),
        ),
        (
            "clf",
            LogisticRegression(
                max_iter=1000,
                n_jobs=-1,
            ),
        ),
    ])


def main():
    print("[train] Loading data...")
    X, y = load_data()
    print(f"[train] Loaded {len(X)} samples")

    # Hold out 20% of train as validation
    X_train, X_val, y_train, y_val = train_test_split(
        X,
        y,
        test_size=0.2,
        random_state=42,
        stratify=y,
    )

    pipe = build_pipeline()

    print("[train] Training TF-IDF + LogisticRegression ...")
    t0 = time.time()
    pipe.fit(X_train, y_train)
    dt = time.time() - t0
    print(f"[train] Training finished in {dt:.1f}s")

    print("[train] Evaluating on validation split ...")
    y_pred = pipe.predict(X_val)
    print(classification_report(y_val, y_pred, digits=3))

    print(f"[train] Saving model to {MODEL_PATH.resolve()} ...")
    joblib.dump(pipe, MODEL_PATH)
    print("[train] Done.")


if __name__ == "__main__":
    main()
