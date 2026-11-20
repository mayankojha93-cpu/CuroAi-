"""
LiveKit AI Outbound Calling Voice Agent package.
"""

def __getattr__(name: str):
    if name in ("server", "entrypoint"):
        from .worker import server, entrypoint
        return server if name == "server" else entrypoint
    raise AttributeError(f"module {__name__!r} has no attribute {name!r}")

__all__ = ["server", "entrypoint"]

