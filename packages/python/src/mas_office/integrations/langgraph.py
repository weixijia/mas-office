"""LangGraph integration (experimental).

Wrap a ``graph.stream(...)`` iterator; every chunk is yielded unchanged while
MAS Office events are emitted on the side:

* ``tasks`` start payload (``id``, ``name``, ``input``, ``triggers``) → ``agent.status working``
* ``tasks`` result payload (``id``, ``name``, ``error``, ``result``, ``interrupts``) →
  ``agent.finished``, ``agent.failed`` (``error``) or ``flag.raised`` ``needs_input`` (``interrupts``)
* ``custom`` dicts with a ``say`` key (from ``get_stream_writer()``) → ``agent.status working``
  when they also carry ``progress``, otherwise ``message``. Add ``"agent": "<node name>"`` to
  pick the desk; otherwise the latest running node in that namespace gets it.

Node names become agent ids via ``slugify``; nodes inside a subgraph get the subgraph's
node as ``parent``. Usage::

    from mas_office import Office
    from mas_office.integrations.langgraph import stream_to_office

    office = Office(workspace="./runs")
    run = office.project("research", title="Research").run()
    stream = graph.stream(inputs, stream_mode=["tasks", "updates", "custom"], subgraphs=True)
    for chunk in stream_to_office(stream, run):
        ...                                  # chunks are unchanged
    run.finish()
    office.close()

    # inside a node:
    from langgraph.config import get_stream_writer
    get_stream_writer()({"say": "Reading 3 papers", "progress": 40})

Accepts ``(mode, chunk)``, ``(namespace, mode, chunk)`` and v2 ``{"type", "ns", "data"}`` parts.
Written against langgraph 1.2 (``TaskPayload`` / ``TaskResultPayload`` in ``langgraph.types``).
Docs: https://docs.langchain.com/oss/python/langgraph/streaming
"""

from __future__ import annotations

from typing import Any, AsyncIterable, AsyncIterator, Dict, Iterable, Iterator, List, Optional, Tuple

from ..office import Agent, Run, slugify
from . import _report

Namespace = Tuple[str, ...]


class _Mapper:
    def __init__(self, run: Run) -> None:
        self.run = run
        self.running: Dict[Namespace, List[Agent]] = {}

    def handle(self, chunk: Any) -> None:
        parts = _split(chunk)
        if parts is None:
            return
        namespace, mode, payload = parts
        if mode == "tasks" and isinstance(payload, dict):
            self._task(namespace, payload)
        elif mode == "custom" and isinstance(payload, dict) and "say" in payload:
            self._custom(namespace, payload)

    def _agent(self, name: str, namespace: Namespace) -> Agent:
        parent = slugify(namespace[-1].split(":")[0]) if namespace else "lead"
        return self.run.agent(slugify(name), name=name, parent=parent)

    def _task(self, namespace: Namespace, payload: Dict[str, Any]) -> None:
        name = payload.get("name")
        if not isinstance(name, str) or name.startswith("__"):  # skip __start__ and other internals
            return
        agent = self._agent(name, namespace)
        running = self.running.setdefault(namespace, [])
        if "result" not in payload and "error" not in payload:  # a start payload
            running.append(agent)
            agent.working(f"Running {name}")
            return
        if agent in running:
            running.remove(agent)
        interrupts = payload.get("interrupts") or []
        if payload.get("error"):
            agent.fail(str(payload["error"]))
        elif interrupts:
            first = interrupts[0]
            value = first.get("value", first) if isinstance(first, dict) else first
            agent.flag(str(value), kind="needs_input")
        else:
            agent.done()

    def _custom(self, namespace: Namespace, payload: Dict[str, Any]) -> None:
        if isinstance(payload.get("agent"), str):
            agent = self._agent(payload["agent"], namespace)
        else:
            running = self.running.get(namespace) or []
            agent = running[-1] if running else self.run.lead
        say = str(payload["say"])
        if "progress" in payload:
            agent.working(say, progress=payload["progress"])
        else:
            agent.say(say)


def _split(chunk: Any) -> Optional[Tuple[Namespace, Optional[str], Any]]:
    """Normalise the stream shapes to ``(namespace, mode, payload)``."""
    if isinstance(chunk, dict) and "type" in chunk and "data" in chunk:
        return tuple(chunk.get("ns") or ()), chunk["type"], chunk["data"]
    if isinstance(chunk, tuple):
        if len(chunk) == 3 and isinstance(chunk[1], str):
            return tuple(chunk[0] or ()), chunk[1], chunk[2]
        if len(chunk) == 2 and isinstance(chunk[0], str):
            return (), chunk[0], chunk[1]
    return None


def stream_to_office(stream: Iterable[Any], run: Run) -> Iterator[Any]:
    """Yield every chunk of ``stream`` unchanged, emitting MAS Office events for ``run``."""
    mapper = _Mapper(run)
    for chunk in stream:
        try:
            mapper.handle(chunk)
        except Exception as exc:  # never break the user's graph
            _report("langgraph", exc)
        yield chunk


async def astream_to_office(stream: AsyncIterable[Any], run: Run) -> AsyncIterator[Any]:
    """Async version of ``stream_to_office`` for ``graph.astream(...)``."""
    mapper = _Mapper(run)
    async for chunk in stream:
        try:
            mapper.handle(chunk)
        except Exception as exc:  # never break the user's graph
            _report("langgraph", exc)
        yield chunk
