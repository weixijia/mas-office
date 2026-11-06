"""Transports: where events go.

* ``FileTransport`` appends to ``<workspace>/<project>/mas/events.jsonl``, runs the reducer
  in-process and rewrites the snapshots after every event (spec 1 and 4).
* ``HttpTransport`` posts batches to a ``mas-office serve`` instance (spec 5) from a
  background thread.

Both check every event at emit time, in the caller's thread: an event that is not
JSON-serialisable or that a writer must refuse (spec 4.1, plus the id pattern of
``AGENT_ID_RE``) is dropped with one ``RuntimeWarning`` per kind of problem. Emitting
never raises into user code.
"""

from __future__ import annotations

import json
import queue
import re
import sys
import threading
import urllib.parse
import urllib.request
import uuid
import warnings
from pathlib import Path
from typing import Any, Dict, List, Optional, Set, Tuple

from . import files
from .reducer import SPEC_VERSION, Reducer, Snapshot, event_errors, parse_log, split_lines

Event = Dict[str, Any]

# Agent ids writers accept (as the JS SDK): they become file names and role ids.
AGENT_ID_RE = re.compile(r"[a-z0-9][a-z0-9-]{0,63}")

# ``mas-office serve`` refuses request bodies over 1 MiB (HTTP 413); stay below 1 MB.
MAX_BODY_BYTES = 1_000_000


def is_valid_agent_id(value: Any) -> bool:
    return isinstance(value, str) and AGENT_ID_RE.fullmatch(value) is not None


def writer_errors(event: Any) -> List[str]:
    """``event_errors`` plus what writers also refuse: ids that cannot become file names or role ids."""
    errors = event_errors(event)
    if isinstance(event, dict):
        if "agentId" in event and not is_valid_agent_id(event["agentId"]):
            errors.append('"agentId" must match ^[a-z0-9][a-z0-9-]{0,63}$')
        data = event.get("data")
        target = data.get("to") if isinstance(data, dict) else None
        if event.get("type") == "handoff" and isinstance(target, str) and not is_valid_agent_id(target):
            errors.append('"data.to" must match ^[a-z0-9][a-z0-9-]{0,63}$')
    return errors


class Transport:
    """Interface shared by both transports. ``event`` has no ``v``/``seq`` yet, but has ``ts``."""

    def __init__(self) -> None:
        self._warned_keys: Set[str] = set()
        self._warn_lock = threading.Lock()

    def warn_once(self, key: str, message: str) -> None:
        """Issue one ``RuntimeWarning`` per ``key`` for the lifetime of this transport."""
        with self._warn_lock:
            if key in self._warned_keys:
                return
            self._warned_keys.add(key)
        # Point the warning at the first frame outside this package (the user's call).
        level, frame = 2, sys._getframe(1)
        while frame.f_back is not None and frame.f_globals.get("__name__", "").split(".")[0] == "mas_office":
            frame, level = frame.f_back, level + 1
        warnings.warn(f"mas-office: {message}", RuntimeWarning, stacklevel=level)

    def _prepare(self, event: Event) -> Optional[Event]:
        """Check an event at emit time. Returns a JSON round-tripped copy without ``seq``,
        or None when the event is dropped (with one warning per kind of problem)."""
        etype = event.get("type")
        label = etype if isinstance(etype, str) else "untyped"
        try:
            clean: Event = json.loads(json.dumps(event, ensure_ascii=False, allow_nan=False))
        except Exception as exc:  # TypeError, ValueError (NaN, cycles), RecursionError, …
            self.warn_once("json", f'dropping a "{label}" event that is not JSON-serialisable ({exc})')
            return None
        clean.pop("seq", None)  # the writer assigns seq
        errors = writer_errors({"v": SPEC_VERSION, **clean, "seq": 1})
        if errors:
            self.warn_once(f"invalid:{label}", f'dropping an invalid "{label}" event: {"; ".join(errors)}')
            return None
        return clean

    def open_project(self, folder: str, title: Optional[str], task: Optional[Dict[str, Any]]) -> None:
        raise NotImplementedError

    def emit(self, folder: str, event: Event) -> None:
        raise NotImplementedError

    def new_run_id(self, folder: str) -> str:
        return "r-" + uuid.uuid4().hex[:8]

    def flush(self, timeout: Optional[float] = None) -> None:
        """Wait until queued events are delivered (no-op for files)."""

    def close(self) -> None:
        self.flush()


# --------------------------------------------------------------------------- files


class _FileProject:
    """One project folder: its log, its in-memory reducer and the snapshots last written."""

    def __init__(self, root: Path, folder: str, title: Optional[str]) -> None:
        self.dir = root / folder
        self.folder = folder
        self.title = title
        self.log = self.dir / "mas" / "events.jsonl"
        self.lock = threading.Lock()
        self.reducer = Reducer()
        self.written: Optional[Snapshot] = None
        self.needs_newline = False
        if self.log.exists():
            raw = self.log.read_bytes()
            self.needs_newline = bool(raw) and not raw.endswith(b"\n")
            for event in parse_log(split_lines(raw.decode("utf-8", errors="replace"))):
                self.reducer.apply(event)

    def home_entry(self, snapshot: Snapshot) -> Dict[str, Any]:
        structure = snapshot["structure"]
        roles = structure.get("roles") or []
        return {
            "folder": self.folder,
            "title": self.title or structure.get("title") or self.folder,
            "step": 4,
            "phase": snapshot["state"]["phase"],
            "agents": len(roles) + 1,
            "runs": snapshot["state"]["run"],
        }


class FileTransport(Transport):
    def __init__(self, workspace: Path) -> None:
        super().__init__()
        self.workspace = workspace
        self._projects: Dict[str, _FileProject] = {}
        self._projects_lock = threading.Lock()
        self._home_lock = threading.Lock()
        self._home_written: Optional[Tuple[str, Dict[str, Any]]] = None

    def _project(self, folder: str) -> _FileProject:
        with self._projects_lock:
            return self._projects[folder]

    def open_project(self, folder: str, title: Optional[str], task: Optional[Dict[str, Any]]) -> None:
        with self._projects_lock:
            if folder in self._projects:
                return
            project = self._projects[folder] = _FileProject(self.workspace, folder, title)
        try:
            if task is not None:
                doc = dict(task)
                if title is not None:
                    doc.setdefault("title", title)
                files.write_document(project.dir / "me" / "task", doc, files.GLOBALS["me/task"])
            if project.reducer.last_seq > 0:
                with project.lock:
                    self._write(project)
        except OSError as exc:
            self._warn(exc)

    def new_run_id(self, folder: str) -> str:
        project = self._project(folder)
        with project.lock:
            return f"r{project.reducer.run + 1}"

    def emit(self, folder: str, event: Event) -> None:
        clean = self._prepare(event)
        if clean is None:
            return
        project = self._project(folder)
        with project.lock:
            full = {"v": clean.pop("v", SPEC_VERSION), "seq": project.reducer.last_seq + 1}
            full.update(clean)
            try:
                project.log.parent.mkdir(parents=True, exist_ok=True)
                with open(project.log, "a", encoding="utf-8", newline="\n") as handle:
                    if project.needs_newline:
                        handle.write("\n")
                    handle.write(json.dumps(full, ensure_ascii=False) + "\n")
                project.needs_newline = False
            except OSError as exc:
                self._warn(exc)
                return
            project.reducer.apply(full)
            try:
                self._write(project)
            except Exception as exc:  # never raise into user code
                self._warn(exc)

    def _write(self, project: _FileProject) -> None:
        """Rewrite changed snapshots and the project's entry in ``home/projects``. Caller holds ``project.lock``."""
        snapshot = project.reducer.snapshot()
        files.write_snapshots(project.dir, snapshot, project.written)
        project.written = snapshot
        self._update_home(project.folder, project.home_entry(snapshot))

    def _update_home(self, folder: str, entry: Dict[str, Any]) -> None:
        with self._home_lock:
            if self._home_written == (folder, entry):
                return
            base = self.workspace / "home" / "projects"
            home = files.read_document(base)
            if not isinstance(home, dict) or not isinstance(home.get("projects"), list):
                home = {"current": None, "projects": []}
            projects: List[Any] = home["projects"]
            for i, item in enumerate(projects):
                if isinstance(item, dict) and item.get("folder") == folder:
                    projects[i] = {**item, **entry}
                    break
            else:
                projects.append(entry)
            home["current"] = folder
            files.write_document(base, home, files.GLOBALS["home/projects"])
            self._home_written = (folder, entry)

    def _warn(self, exc: BaseException) -> None:
        self.warn_once("write", f"could not write to {self.workspace}: {exc}")


# ---------------------------------------------------------------------------- HTTP

_STOP = object()


class HttpTransport(Transport):
    """Posts events to ``<url>/v0/events?project=<folder>`` in batches, from one background thread.

    Events are serialised at ``emit`` time. A batch holds at most ``batch_size`` events and
    stays under ``MAX_BODY_BYTES``; a single event larger than that is dropped with a warning.
    Delivery failures never raise: the batch is dropped and one ``RuntimeWarning`` is issued
    (on the caller's thread, at the next ``emit``/``flush``/``close``).
    """

    def __init__(self, url: str, *, batch_size: int = 100, timeout: float = 5.0, max_queue: int = 10000) -> None:
        super().__init__()
        self.url = url.rstrip("/")
        self.batch_size = batch_size
        self.timeout = timeout
        self._queue: "queue.Queue[Any]" = queue.Queue(maxsize=max_queue)
        self._pending = 0
        self._cond = threading.Condition()
        self._error: Optional[str] = None
        self._closed = False
        self._thread = threading.Thread(target=self._worker, name="mas-office-http", daemon=True)
        self._thread.start()

    def open_project(self, folder: str, title: Optional[str], task: Optional[Dict[str, Any]]) -> None:
        # The HTTP API (spec 5) has no endpoint for me/task; the server owns home/projects.
        return None

    def emit(self, folder: str, event: Event) -> None:
        self._maybe_warn()
        if self._closed:
            return
        clean = self._prepare(event)
        if clean is None:
            return
        full = {"v": clean.pop("v", SPEC_VERSION)}
        full.update(clean)
        body = json.dumps(full, ensure_ascii=False).encode("utf-8")
        if len(body) + 2 > MAX_BODY_BYTES:
            self.warn_once("too-large", f'dropping a "{full["type"]}" event of {len(body)} bytes: '
                                        f"the server accepts at most {MAX_BODY_BYTES} bytes per request")
            return
        with self._cond:
            self._pending += 1
        try:
            self._queue.put_nowait((folder, body))
        except queue.Full:
            self._done(1)
            self._error = self._error or "the send queue is full"

    def flush(self, timeout: Optional[float] = None) -> None:
        with self._cond:
            self._cond.wait_for(lambda: self._pending == 0, timeout=self.timeout * 2 if timeout is None else timeout)
        self._maybe_warn()

    def close(self) -> None:
        if self._closed:
            return
        self.flush()
        self._closed = True
        self._queue.put(_STOP)
        self._thread.join(timeout=self.timeout)
        self._maybe_warn()

    # ------------------------------------------------------------ worker thread

    def _worker(self) -> None:
        while True:
            item = self._queue.get()
            if item is _STOP:
                return
            batch = [item]
            stop = False
            try:
                while len(batch) < self.batch_size:
                    try:
                        nxt = self._queue.get_nowait()
                    except queue.Empty:
                        break
                    if nxt is _STOP:
                        stop = True
                        break
                    batch.append(nxt)
                self._send(batch)
            except Exception as exc:  # keep the worker alive; drop the batch
                self._error = self._error or f"could not send events to {self.url}: {exc}"
            finally:
                self._done(len(batch))
            if stop:
                return

    def _send(self, batch: List[Tuple[str, bytes]]) -> None:
        """POST consecutive events of the same project together (keeps order), each body < MAX_BODY_BYTES."""
        start = 0
        for i in range(1, len(batch) + 1):
            if i < len(batch) and batch[i][0] == batch[start][0]:
                continue
            folder = batch[start][0]
            chunk: List[bytes] = []
            size = 2  # the enclosing brackets
            for _, body in batch[start:i]:
                if chunk and size + len(body) + 1 > MAX_BODY_BYTES:
                    self._post(folder, chunk)
                    chunk, size = [], 2
                chunk.append(body)
                size += len(body) + 1  # the event plus a comma
            self._post(folder, chunk)
            start = i

    def _post(self, folder: str, events: List[bytes]) -> None:
        url = f"{self.url}/v0/events?project={urllib.parse.quote(folder)}"
        body = b"[" + b",".join(events) + b"]"
        request = urllib.request.Request(url, data=body, method="POST", headers={"Content-Type": "application/json"})
        try:
            with urllib.request.urlopen(request, timeout=self.timeout) as response:
                response.read()
        except Exception as exc:  # never raise into user code; drop the batch
            self._error = self._error or f"could not send events to {self.url}: {exc}"

    def _done(self, n: int) -> None:
        with self._cond:
            self._pending -= n
            self._cond.notify_all()

    def _maybe_warn(self) -> None:
        if self._error is not None:
            self.warn_once("delivery", f"{self._error}; events were dropped")
