from fastapi import FastAPI

app = FastAPI(title="olftransfer")


@app.get("/health")
def health():
    return {"status": "ok"}
