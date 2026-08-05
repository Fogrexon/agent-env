# Python / uv notes

Agent-local Python lives under `agents/<id>/python/` and must use **uv**:

- `uv venv`
- `uv pip install -r requirements.txt --python .venv`

Harness APIs: `ensurePythonEnv`, `createPythonScriptTool`.

Do not fall back to `python -m venv` or global pip installs.
