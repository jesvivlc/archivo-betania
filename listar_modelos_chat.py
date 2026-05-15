import requests
import os
from dotenv import load_dotenv

load_dotenv()
GEMINI_API_KEY = os.getenv("GEMINI_API_KEY")

resp = requests.get(
    "https://generativelanguage.googleapis.com/v1beta/models",
    headers={"x-goog-api-key": GEMINI_API_KEY}
)
data = resp.json()
for model in data.get("models", []):
    methods = model.get("supportedGenerationMethods", [])
    if "generateContent" in methods:
        print(model["name"])
