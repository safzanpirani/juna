"""Python cells with durable snapshots; control traffic uses fd 3."""

import ast
import asyncio
import inspect
import io
import json
import os
import sys
import threading
import traceback
import types
from checkpoint import Checkpoint, unsupported_names


def main():
    protocol = os.fdopen(3, "w", buffering=1, encoding="utf-8")
    incoming = sys.stdin
    sys.stdin = io.StringIO("")
    lock = threading.Lock()
    loop = asyncio.new_event_loop()
    asyncio.set_event_loop(loop)
    cells = asyncio.Queue()
    pending = {}
    sequence = 0
    cell_id = None

    def send(message):
        with lock:
            protocol.write(json.dumps(message, ensure_ascii=True) + "\n")

    class Output(io.TextIOBase):
        def writable(self):
            return True

        def write(self, text):
            # Bound protocol frames even for a single enormous print().
            for offset in range(0, len(text), 4096):
                send({"type": "output", "cell": cell_id, "text": text[offset:offset + 4096]})
            return len(text)

        def flush(self):
            pass

    sys.stdout = Output()
    sys.stderr = Output()

    def receive(message):
        if message.get("type") == "run":
            cells.put_nowait(message)
        elif message.get("type") == "result":
            future = pending.pop(message.get("id"), None)
            if future is not None and not future.done():
                if message.get("ok"):
                    future.set_result(message.get("text", ""))
                else:
                    future.set_exception(RuntimeError(message.get("error", "Tool failed")))

    def reader():
        try:
            for line in incoming:
                loop.call_soon_threadsafe(receive, json.loads(line))
        finally:
            # Parent disappeared: do not leave a live kernel behind.
            os._exit(0)

    class Tools:
        async def call(self, name, **kwargs):
            nonlocal sequence
            sequence += 1
            request_id = sequence
            future = loop.create_future()
            pending[request_id] = future
            send({"type": "call", "cell": cell_id, "id": request_id, "tool": name, "args": kwargs})
            try:
                return await future
            finally:
                pending.pop(request_id, None)

        def read(self, path, **kwargs):
            return self.call("read", path=str(path), **kwargs)

        def write(self, path, content):
            return self.call("write", path=str(path), content=content)

        def edit(self, path, old_text, new_text):
            return self.call("edit", path=str(path), edits=[{"oldText": old_text, "newText": new_text}])

        def bash(self, command, **kwargs):
            return self.call("bash", command=command, **kwargs)

        def web_search(self, query, **kwargs):
            return self.call("web_search", query=query, **kwargs)

        def web_fetch(self, url, **kwargs):
            return self.call("web_fetch", url=url, **kwargs)

    module = types.ModuleType("__juna_python__")
    sys.modules[module.__name__] = module
    namespace = module.__dict__
    store = None
    startup_error = None
    startup_notice = ""
    try:
        if len(sys.argv) > 1:
            store = Checkpoint(sys.argv[1])
            startup_notice = store.restore(module)
    except BaseException as error:
        startup_error = "Python checkpoint could not be restored: " + str(error) + ". No cell was executed."
    namespace["tools"] = Tools()

    async def serve():
        nonlocal cell_id, startup_notice
        while True:
            message = await cells.get()
            cell_id = message["id"]
            error = None
            try:
                if startup_error:
                    raise RuntimeError(startup_error)
                if startup_notice:
                    print(startup_notice)
                    startup_notice = ""
                if store:
                    store.begin()
                if message.get("reset"):
                    namespace.clear()
                    namespace.update({"__name__": "__juna_python__", "tools": Tools()})
                code = compile(message["code"], "<juna-python>", "exec", flags=ast.PyCF_ALLOW_TOP_LEVEL_AWAIT)
                value = eval(code, namespace)
                if inspect.isawaitable(value):
                    await value
            except BaseException:
                error = traceback.format_exc()
            # No asynchronous work may escape its owning cell. Keep the event
            # loop itself alive so retained async objects remain usable.
            leftover = [task for task in asyncio.all_tasks() if task is not asyncio.current_task()]
            if leftover:
                for task in leftover:
                    task.cancel()
                await asyncio.gather(*leftover, return_exceptions=True)
                error = (error or "") + "\nUnawaited background tasks were cancelled. Await all work before ending a cell."
            if store and not startup_error:
                helper = namespace.pop("tools", None)
                try:
                    store.save(module)
                except BaseException as failure:
                    try:
                        names = unsupported_names(namespace)
                    except BaseException:
                        names = []
                    error = (error or "") + "\nCheckpoint failed (" + type(failure).__name__ + "). Live state remains, but the previous durable checkpoint was preserved. Remove unsupported values or save their data to files before restarting."
                    if names:
                        error += " Unsupported variables: " + ", ".join(names)
                finally:
                    namespace["tools"] = helper
            # Separate OS pipes can be delivered in a different order. The host
            # waits for these fences before resolving the control response.
            try:
                for fd in (1, 2):
                    os.write(fd, ("\x1e" + message["fence"] + ":" + str(fd) + "\x1f").encode())
            except OSError:
                send({"type": "fatal", "cell": cell_id, "error": "Python output stream closed"})
                return
            send({"type": "done", "cell": cell_id, "error": error})

    threading.Thread(target=reader, daemon=True).start()
    loop.run_until_complete(serve())


if __name__ == "__main__":
    main()
