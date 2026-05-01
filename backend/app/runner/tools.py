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


def web_fetch(urls: list[str], objective: str, full_content: bool) -> dict:
    """Fetch URL(s) as LLM-clean markdown via parallel.ai Extract.

    The caller chooses ``full_content``: ``True`` returns the entire page
    markdown (use when reading an article/paper/doc end-to-end); ``False``
    returns only objective-targeted excerpts (cheaper; use when looking up
    a specific fact).
    """
    api_key = os.getenv("PARALLEL_API_KEY", "")
    if not api_key:
        return {"error": "PARALLEL_API_KEY not set", "results": []}
    body: dict = {"urls": urls, "objective": objective}
    if full_content:
        body["advanced_settings"] = {"full_content": True}
    with httpx.Client(timeout=120) as client:
        r = client.post(
            "https://api.parallel.ai/v1/extract",
            headers={"x-api-key": api_key, "Content-Type": "application/json"},
            json=body,
        )
        if r.status_code >= 400:
            return {"error": f"parallel.ai {r.status_code}: {r.text}", "results": []}
        try:
            return r.json()
        except Exception:
            return {"error": "non-json response", "raw": r.text}


REGISTRY = {
    "shell": shell,
    "web_search": web_search,
    "web_fetch": web_fetch,
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
    "web_fetch": {
        "type": "function",
        "function": {
            "name": "web_fetch",
            "description": (
                "Fetch one or more URLs as LLM-clean markdown via parallel.ai Extract. "
                "Handles JS-rendered pages and PDFs."
            ),
            "parameters": {
                "type": "object",
                "properties": {
                    "urls": {"type": "array", "items": {"type": "string"}},
                    "objective": {
                        "type": "string",
                        "description": "What you're trying to extract; narrows the excerpts.",
                    },
                    "full_content": {
                        "type": "boolean",
                        "description": (
                            "True = return the entire page markdown (use when you need "
                            "to read a page end-to-end: articles, papers, docs). "
                            "False = return only objective-targeted excerpts (cheaper; "
                            "use when looking up a specific fact). Decide per call."
                        ),
                    },
                },
                "required": ["urls", "objective", "full_content"],
            },
        },
    },
}
