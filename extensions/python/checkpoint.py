"""Atomic, session-local snapshots. Only load checkpoints created by this user."""

import io
import json
import os
from pathlib import Path
import sys
import tempfile
import time
import asyncio
import socket
import threading
import types


def unsupported_names(namespace):
    """Reject resources dill can sometimes recreate with misleading semantics."""
    resources = (io.IOBase, socket.socket, threading.Thread, asyncio.Future,
                 asyncio.AbstractEventLoop, types.GeneratorType, types.CoroutineType,
                 types.AsyncGeneratorType, type(threading.Lock()), type(threading.RLock()))
    def contains(value, seen):
        if id(value) in seen:
            return False
        seen.add(id(value))
        if isinstance(value, resources):
            return True
        if isinstance(value, (types.ModuleType, types.FunctionType, type)):
            return False
        if isinstance(value, dict):
            return any(contains(k, seen) or contains(v, seen) for k, v in value.items())
        if isinstance(value, (list, tuple, set, frozenset)):
            return any(contains(v, seen) for v in value)
        attributes = getattr(value, "__dict__", None)
        return isinstance(attributes, dict) and contains(attributes, seen)
    return [name for name, value in namespace.items()
            if name != "__builtins__" and contains(value, set())]


class Checkpoint:
    def __init__(self, directory):
        try:
            import dill
            import fcntl
        except ImportError as error:
            raise RuntimeError("Durable Python requires POSIX and dill==0.4.1 in JUNA_PYTHON; see README setup") from error
        self.dill = dill
        self.directory = Path(directory)
        self.directory.mkdir(mode=0o700, parents=True, exist_ok=True)
        os.chmod(self.directory, 0o700)
        self.path = self.directory / "state.bin"
        self.pending = self.directory / "inflight.json"
        self.lock = open(self.directory / "lock", "a+b")
        os.chmod(self.directory / "lock", 0o600)
        deadline = time.monotonic() + 2
        while True:
            try:
                fcntl.flock(self.lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
                break
            except BlockingIOError:
                if time.monotonic() >= deadline:
                    raise RuntimeError("Python session is already open in another process; close it before resuming")
                time.sleep(0.02)

    def atomic(self, path, payload):
        fd, temporary = tempfile.mkstemp(dir=self.directory)
        try:
            with os.fdopen(fd, "wb") as stream:
                stream.write(payload)
                stream.flush()
                os.fsync(stream.fileno())
            os.replace(temporary, path)
            self.sync_directory()
        finally:
            if os.path.exists(temporary):
                os.unlink(temporary)

    def sync_directory(self):
        fd = os.open(self.directory, os.O_RDONLY)
        try:
            os.fsync(fd)
        finally:
            os.close(fd)

    def restore(self, module):
        notice = ""
        if self.path.exists():
            with self.path.open("rb") as stream:
                header = json.loads(stream.readline())
                if header.get("version") != 1 or header.get("python") != list(sys.version_info[:2]) or header.get("dill") != self.dill.__version__:
                    raise RuntimeError("Checkpoint runtime version differs; restore using the original Python and dill versions")
                self.dill.load_module(stream, module=module)
                os.chdir(header["cwd"])
            notice = "Restored durable Python state."
        if self.pending.exists():
            notice += " Previous cell was interrupted or could not checkpoint. Only the last committed state was restored; external effects may have occurred. Nothing was replayed."
        return notice

    def begin(self):
        self.atomic(self.pending, b'{"status":"inflight"}\n')

    def save(self, module):
        # All-or-nothing: do not silently omit variables or overwrite a good
        # snapshot if one value cannot be serialized.
        unsupported = unsupported_names(module.__dict__)
        if unsupported:
            raise TypeError("Unsupported live resources: " + ", ".join(unsupported))
        buffer = io.BytesIO()
        header = {"version": 1, "python": list(sys.version_info[:2]), "dill": self.dill.__version__, "cwd": os.getcwd()}
        buffer.write(json.dumps(header).encode() + b"\n")
        self.dill.dump_module(buffer, module=module)
        self.atomic(self.path, buffer.getvalue())
        self.pending.unlink(missing_ok=True)
        self.sync_directory()
