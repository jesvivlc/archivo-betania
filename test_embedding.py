import os
import requests
from dotenv import load_dotenv

load_dotenv()
GEMINI_API_KEY = os.getenv("GEMINI_API_KEY")

resp = requests.post(
    "https://generativelanguage.googleapis.com/v1beta/models/gemini-embedding-2-preview:embedContent",
    headers={"Content-Type": "application/json", "x-goog-api-key": GEMINI_API_KEY},
    json={
        "model":   "models/gemini-embedding-2-preview",
        "content": {"parts": [{"text": "hola mundo"}]},
    },
    timeout=30,
)

print(f"Status: {resp.status_code}")
if resp.ok:
    embedding = resp.json()["embedding"]["values"]
    print(f"Dimensiones: {len(embedding)}")
else:
    print(f"Error: {resp.text}")
