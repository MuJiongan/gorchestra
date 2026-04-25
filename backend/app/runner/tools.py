"""Tool registry. Each tool is a plain Python callable, plus a JSON schema for LLM tool-calling."""
from __future__ import annotations
import os
import subprocess
import httpx


def shell(command: str, timeout: int = 30) -> dict:
    """Run a shell command. Returns {stdout, stderr, returncode}."""
    try:
        result = subprocess.run(
            command, shell=True, capture_output=True, text=True, timeout=timeout
        )
        return {
            "stdout": result.stdout,
            "stderr": result.stderr,
            "returncode": result.returncode,
        }
    except subprocess.TimeoutExpired as e:
        return {
            "stdout": (e.stdout or "") if isinstance(e.stdout, str) else "",
            "stderr": "TIMEOUT",
            "returncode": -1,
        }


def fetch(
    url: str,
    method: str = "GET",
    headers: dict | None = None,
    json: dict | None = None,
    params: dict | None = None,
    timeout: int = 30,
) -> dict:
    """HTTP request. Returns {status, headers, body}."""
    with httpx.Client(timeout=timeout) as client:
        r = client.request(method, url, headers=headers, json=json, params=params)
        try:
            body = r.json()
        except Exception:
            body = r.text
        return {"status": r.status_code, "headers": dict(r.headers), "body": body}


def web_search(query: str, max_results: int = 5) -> dict:
    """Web search via parallel.ai."""
    api_key = os.getenv("PARALLEL_API_KEY", "")
    if not api_key:
        return {"error": "PARALLEL_API_KEY not set", "results": []}
    with httpx.Client(timeout=60) as client:
        r = client.post(
            "https://api.parallel.ai/v1beta/search",
            headers={"x-api-key": api_key, "Content-Type": "application/json"},
            json={"objective": query, "max_results": max_results},
        )
        if r.status_code >= 400:
            return {"error": f"parallel.ai {r.status_code}: {r.text}", "results": []}
        try:
            return r.json()
        except Exception:
            return {"error": "non-json response", "raw": r.text}


REGISTRY = {
    "shell": shell,
    "fetch": fetch,
    "web_search": web_search,
}


TOOL_SCHEMAS = {
    "shell": {
        "type": "function",
        "function": {
            "name": "shell",
            "description": "Execute a shell command and return stdout/stderr/returncode. Covers file I/O via cat, ls, mv, etc.",
            "parameters": {
                "type": "object",
                "properties": {
                    "command": {"type": "string", "description": "Shell command to execute"},
                    "timeout": {"type": "integer", "description": "Timeout seconds", "default": 30},
                },
                "required": ["command"],
            },
        },
    },
    "fetch": {
        "type": "function",
        "function": {
            "name": "fetch",
            "description": "Make an HTTP request. Returns {status, headers, body}.",
            "parameters": {
                "type": "object",
                "properties": {
                    "url": {"type": "string"},
                    "method": {"type": "string", "default": "GET"},
                    "headers": {"type": "object"},
                    "json": {"type": "object"},
                    "params": {"type": "object"},
                },
                "required": ["url"],
            },
        },
    },
    "web_search": {
        "type": "function",
        "function": {
            "name": "web_search",
            "description": "Search the web for the given query.",
            "parameters": {
                "type": "object",
                "properties": {
                    "query": {"type": "string"},
                    "max_results": {"type": "integer", "default": 5},
                },
                "required": ["query"],
            },
        },
    },
}
