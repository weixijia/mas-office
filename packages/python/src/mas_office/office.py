"""Public API: ``Office`` → ``Project`` → ``Run`` → ``Agent``.

    from mas_office import Office

    with Office(workspace="./runs") as office:
        project = office.project("headphone-deals", title="Headphone deals")
        run = project.run()
        finder = run.agent("finder", name="Retail finder", emoji="🔎")
        finder.working("Searching Currys", progress=20)
        with finder.tool("web_search"):
            ...
        finder.done("Found 3 offers")
        run.result(markdown="## Shortlist\\n- …")
        run.finish()
"""

from __future__ import annotations

import os
import re
import threading
import uuid
from datetime import datetime, timezone
from pathlib import Path
from types import TracebackType
from typing import Any, Dict, List, Optional, Type, Union

from .transport import FileTransport, HttpTransport, Transport, is_valid_agent_id

FOLDER_RE = re.compile(r"[a-z0-9][a-z0-9-]{0,39}")
EVIDENCE = ("A", "B", "C", "D")


def now() -> str:
    """Current UTC time as ISO 8601 with milliseconds and a ``Z`` suffix."""
    return datetime.now(timezone.utc).isoformat(timespec="milliseconds").replace("+00:00", "Z")


def slugify(name: str, max_length: int = 64) -> str:
    """Turn any name (``"Retail Finder #2"``) into a valid agent id (``"retail-finder-2"``).

    Never returns ``"lead"`` (a framework agent called "Lead" becomes ``"lead-agent"``), so a
    foreign agent cannot merge into the MAS Office lead.
    """
    slug = re.sub(r"[^a-z0-9]+", "-", str(name).lower()).strip("-")[:max_length].strip("-")
    if not slug:
        return "agent"
    return "lead-agent" if slug == "lead" else slug


def validate_folder(folder: str) -> str:
    if not isinstance(folder, str) or not FOLDER_RE.fullmatch(folder):
        raise ValueError(f"invalid project folder {folder!r}: use 1-40 characters a-z, 0-9 and '-', starting with a letter or digit")
    return folder


def _validate_agent_id(agent_id: str) -> str:
    if not is_valid_agent_id(agent_id):
        raise ValueError(f"invalid agent id {agent_id!r}: use 1-64 characters a-z, 0-9 and '-' (try mas_office.slugify)")
    return agent_id


def _compact(**fields: Any) -> Dict[str, Any]:
    """Drop None values, so optional fields are simply absent from ``data``."""
    return {k: v for k, v in fields.items() if v is not None}


class Office:
    """Entry point. Use ``workspace=`` for the file transport, or ``url=`` for ``mas-office serve``."""

    def __init__(self, workspace: Union[str, "os.PathLike[str]", None] = None, *, url: Optional[str] = None) -> None:
        if workspace is not None and url is not None:
            raise ValueError("pass either workspace= or url=, not both")
        self.workspace: Optional[Path] = None
        self.url = url
        if url is not None:
            self._transport: Transport = HttpTransport(url)
        else:
            self.workspace = Path(workspace if workspace is not None else "./runs")
            self._transport = FileTransport(self.workspace)
        self._projects: Dict[str, Project] = {}
        self._lock = threading.Lock()

    def project(self, folder: str, *, title: Optional[str] = None, task: Optional[Dict[str, Any]] = None) -> "Project":
        """Open (or create) a project folder. With the file transport, ``task`` is written to ``me/task``."""
        validate_folder(folder)
        with self._lock:
            existing = self._projects.get(folder)
            if existing is not None:
                return existing
            project = self._projects[folder] = Project(self, folder, title)
        self._transport.open_project(folder, title, task)
        return project

    def flush(self, timeout: Optional[float] = None) -> None:
        """Wait until every event has been delivered (only the HTTP transport queues events)."""
        self._transport.flush(timeout)

    def close(self) -> None:
        self._transport.close()

    def __enter__(self) -> "Office":
        return self

    def __exit__(self, exc_type: Optional[Type[BaseException]], exc: Optional[BaseException], tb: Optional[TracebackType]) -> None:
        self.close()


class Project:
    """One MAS folder in the workspace."""

    def __init__(self, office: Office, folder: str, title: Optional[str]) -> None:
        self.office = office
        self.folder = folder
        self.title = title

    def run(self, structure: Optional[Dict[str, Any]] = None, *, run_id: Optional[str] = None) -> "Run":
        """Start a run (emits ``run.started``). ``structure`` declares the team (spec 2.1); omit it for a dynamic team."""
        run = Run(self, run_id or self.office._transport.new_run_id(self.folder), structure)
        run.emit("run.started", _compact(title=self.title, structure=structure))
        return run

    def emit(self, event: Dict[str, Any]) -> None:
        """Low level: send one event envelope (without ``v``/``seq``, which the transport adds)."""
        full = {"ts": now()}
        full.update(event)
        self.office._transport.emit(self.folder, full)


class Run:
    """One run of the team. ``run.lead`` is the lead's handle; ``run.agent(id)`` gives the others."""

    def __init__(self, project: Project, run_id: str, structure: Optional[Dict[str, Any]]) -> None:
        self.project = project
        self.id = run_id
        self.structure = structure
        declared = structure if isinstance(structure, dict) else {}
        roles = declared.get("roles")
        self._declared: Dict[str, Dict[str, Any]] = {
            r["id"]: r for r in (roles if isinstance(roles, list) else [])
            if isinstance(r, dict) and isinstance(r.get("id"), str)
        }
        self._agents: Dict[str, Agent] = {}
        self._lock = threading.RLock()
        self._ended = False
        lead = declared.get("lead")
        lead_name = lead.get("name") if isinstance(lead, dict) else None
        self.lead = Agent(self, "lead", name=lead_name if isinstance(lead_name, str) else "Lead", registered=True)

    def agent(
        self,
        agent_id: str,
        *,
        name: Optional[str] = None,
        emoji: Optional[str] = None,
        job: Optional[str] = None,
        group: Optional[str] = None,
        hands_to: Optional[str] = None,
        parent: Union[str, "Agent", None] = None,
        role: Optional[str] = None,
    ) -> "Agent":
        """Handle for an agent. Agents not declared in the structure are registered on first use."""
        if agent_id == "lead":
            return self.lead
        _validate_agent_id(agent_id)
        with self._lock:
            handle = self._agents.get(agent_id)
            if handle is None:
                declared = self._declared.get(agent_id)
                declared_name = (declared or {}).get("name")
                handle = Agent(
                    self,
                    agent_id,
                    name=name or (declared_name if isinstance(declared_name, str) else None) or agent_id,
                    parent=parent.id if isinstance(parent, Agent) else parent,
                    registration=_compact(name=name, emoji=emoji, job=job, group=group, handsTo=hands_to, role=role),
                    registered=declared is not None,
                )
                self._agents[agent_id] = handle
            return handle

    def emit(self, type: str, data: Optional[Dict[str, Any]] = None, *, agent: Optional["Agent"] = None,
             raw: Any = None, trace: Optional[Dict[str, Any]] = None) -> None:
        """Low level: emit an event of any type for this run (from the lead unless ``agent`` is given)."""
        event: Dict[str, Any] = {"ts": now(), "runId": self.id, "type": type, "agentId": "lead"}
        if agent is not None and agent.id != "lead":
            event["agentId"] = agent.id
            event["agentName"] = agent.name
            if agent.parent is not None:
                event["parentId"] = agent.parent
        event["data"] = data or {}
        if raw is not None:
            event["raw"] = raw
        if trace is not None:
            event["trace"] = trace
        self.project.office._transport.emit(self.project.folder, event)

    def result(self, markdown: Optional[str] = None, *, title: Optional[str] = None,
               sources: Optional[List[Dict[str, Any]]] = None, flags: Optional[List[Dict[str, Any]]] = None,
               work: Optional[List[Dict[str, Any]]] = None) -> None:
        """Publish the final answer (``result``). Sources and flags collected during the run are included."""
        self.emit("result", _compact(title=title, markdown=markdown, sources=sources, flags=flags, work=work))

    def finish(self, say: Optional[str] = None) -> None:
        self._ended = True
        self.emit("run.finished", _compact(say=say))

    def fail(self, reason: Optional[str] = None) -> None:
        self._ended = True
        self.emit("run.failed", _compact(reason=reason))

    def follow_up(self, question: Optional[str] = None, *, round: Optional[int] = None) -> None:
        """Start a follow-up round on this run's result (``round.started``). The next ``result`` is that round."""
        self._ended = False
        self.emit("round.started", _compact(round=round, question=question))

    def claim(self, text: str, **options: Any) -> str:
        """The lead records a checkable claim (``claim.added``); see ``Agent.claim``. Returns the claim id."""
        return self.lead.claim(text, **options)

    def __enter__(self) -> "Run":
        return self

    def __exit__(self, exc_type: Optional[Type[BaseException]], exc: Optional[BaseException], tb: Optional[TracebackType]) -> None:
        """``with project.run() as run:`` finishes the run, or fails it if the block raised."""
        if exc_type is not None:
            self.fail(str(exc) or exc_type.__name__)
        elif not self._ended:
            self.finish()


class Agent:
    """Handle for one agent (or the lead). Every method emits one event.

    Emitting never raises: an invalid event (e.g. ``say(None)``, an unknown state, a handoff
    to ``"Checker Bot"``, data that is not JSON-serialisable) is dropped with a ``RuntimeWarning``.
    """

    def __init__(self, run: Run, agent_id: str, *, name: str, parent: Optional[str] = None,
                 registration: Optional[Dict[str, Any]] = None, registered: bool = False) -> None:
        self.run = run
        self.id = agent_id
        self.name = name
        self.parent = parent
        self._registration = registration or {}
        self._registered = registered

    # --------------------------------------------------------------- plumbing

    def ensure_registered(self) -> None:
        """Emit ``agent.registered`` now if this agent is not in the structure and was not registered yet."""
        with self.run._lock:
            if self._registered:
                return
            self._registered = True
            self.run.emit("agent.registered", dict(self._registration), agent=self)

    def emit(self, type: str, data: Optional[Dict[str, Any]] = None, *, raw: Any = None,
             trace: Optional[Dict[str, Any]] = None) -> None:
        """Low level: emit any event type (e.g. ``custom.my-thing``) from this agent."""
        self.ensure_registered()
        self.run.emit(type, data, agent=self, raw=raw, trace=trace)

    # ------------------------------------------------------------------ status

    def status(self, state: str, *, say: Optional[str] = None, progress: Optional[float] = None,
               to: Union[str, "Agent", None] = None, flag: Optional[str] = None, flag_kind: Optional[str] = None) -> None:
        """Set any of the seven states (``agent.status``); an unknown state is dropped with a warning."""
        self.emit("agent.status", _compact(state=state, say=say, progress=progress, to=self._target(to),
                                           flag=flag, flagKind=flag_kind))

    def working(self, say: Optional[str] = None, *, progress: Optional[float] = None) -> None:
        self.status("working", say=say, progress=progress)

    def waiting(self, say: Optional[str] = None) -> None:
        self.status("waiting", say=say)

    def say(self, text: str, *, to: Union[str, "Agent", None] = None) -> None:
        """One short line (``message``); wakes an idle or waiting agent."""
        self.emit("message", _compact(text=text, to=self._target(to)))

    def done(self, say: Optional[str] = None) -> None:
        self.emit("agent.finished", _compact(say=say))

    def fail(self, reason: Optional[str] = None) -> None:
        self.emit("agent.failed", _compact(reason=reason))

    def handoff(self, to: Union[str, "Agent"], *, say: Optional[str] = None, reason: Optional[str] = None) -> None:
        self.emit("handoff", _compact(to=self._target(to), say=say, reason=reason))

    def flag(self, text: str, *, kind: str = "concern") -> None:
        """Raise a problem (``flag.raised``): ``concern``, ``needs_input``, ``needs_approval`` or ``error``."""
        self.emit("flag.raised", {"text": text, "kind": kind})

    def resolve(self, request_id: Optional[str] = None, *, outcome: Optional[str] = None,
                option_id: Optional[str] = None, payload: Any = None, note: Optional[str] = None,
                by: Optional[Dict[str, Any]] = None, cmd_id: Optional[str] = None) -> None:
        """Without a request id: clear this agent's flag (``flag.resolved``).

        With one: close that request (``request.resolved``). ``outcome`` defaults to ``selected``
        when ``option_id`` is given, otherwise ``submitted``.
        """
        if request_id is None:
            self.emit("flag.resolved")
            return
        if outcome is None:
            outcome = "submitted" if option_id is None else "selected"
        self.emit("request.resolved", _compact(requestId=request_id, outcome=outcome, optionId=option_id,
                                               payload=payload, note=note, by=by, cmdId=cmd_id))

    # ---------------------------------------------------- requests and usage (0.2)

    def request(self, title: str, *, kind: str = "question", request_id: Optional[str] = None,
                description: Optional[str] = None, options: Optional[List[Dict[str, Any]]] = None,
                blocking: Optional[bool] = None, route_to: Optional[str] = None, resolver: Optional[str] = None,
                urgency: Optional[str] = None, tool_call_id: Optional[str] = None,
                subject: Optional[Dict[str, Any]] = None, response_schema: Optional[Dict[str, Any]] = None,
                expires_at: Optional[str] = None, on_expire: Optional[str] = None,
                source: Optional[Dict[str, Any]] = None) -> str:
        """Ask for something that needs an answer (``request.opened``); returns the request id.

        ``kind`` is ``approval``, ``question`` (default), ``decision``, ``flag`` or ``gate``. A blocking
        request (the default) shows the agent as flagged until it is resolved.
        """
        request_id = request_id or f"req-{uuid.uuid4().hex[:8]}"
        self.emit("request.opened", _compact(
            requestId=request_id, kind=kind, title=title, description=description, options=options,
            blocking=blocking, routeTo=route_to, resolver=resolver, urgency=urgency, toolCallId=tool_call_id,
            subject=subject, responseSchema=response_schema, expiresAt=expires_at, onExpire=on_expire, source=source))
        return request_id

    def stopped(self, reason: Optional[str] = None, *, scope: Optional[str] = None,
                by: Optional[Dict[str, Any]] = None) -> None:
        """The agent's session stopped (``agent.stopped``): ``scope`` ``turn`` (default) or ``agent``."""
        self.emit("agent.stopped", _compact(reason=reason, scope=scope, by=by))

    def usage(self, *, input_tokens: Optional[float] = None, output_tokens: Optional[float] = None,
              cost_usd: Optional[float] = None, turns: Optional[float] = None,
              limit: Optional[Dict[str, Any]] = None) -> None:
        """Usage totals so far for this agent (``usage``)."""
        self.emit("usage", _compact(inputTokens=input_tokens, outputTokens=output_tokens, costUsd=cost_usd,
                                    turns=turns, limit=limit))

    # ------------------------------------------------------- verification (0.2)

    def claim(self, text: str, *, claim_id: Optional[str] = None, sources: Optional[List[str]] = None,
              serves: Optional[str] = None, checkworthy: Optional[bool] = None) -> str:
        """Record a checkable claim (``claim.added``) authored by this agent; returns the claim id."""
        claim_id = claim_id or f"claim-{uuid.uuid4().hex[:8]}"
        self.emit("claim.added", _compact(claimId=claim_id, text=text, sources=sources, serves=serves,
                                          checkworthy=checkworthy))
        return claim_id

    def evidence(self, source_id: str, *, url: Optional[str] = None, url_health: Optional[str] = None,
                 http_status: Optional[int] = None, archived_url: Optional[str] = None, grade: Optional[str] = None,
                 quote: Optional[str] = None, note: Optional[str] = None) -> None:
        """Record what this agent found about a source (``evidence.checked``)."""
        self.emit("evidence.checked", _compact(sourceId=source_id, url=url, urlHealth=url_health,
                                               httpStatus=http_status, archivedUrl=archived_url, grade=grade,
                                               quote=quote, note=note))

    def verdict(self, claim_id: str, status: str, *, source_id: Optional[str] = None,
                relationship: Optional[str] = None, method: Optional[str] = None, note: Optional[str] = None,
                backend: Optional[str] = None) -> None:
        """Record this agent's verdict on a claim (``verdict.recorded``): ``supported``, ``partial``,
        ``contradicted``, ``unknown`` or ``not-checkworthy``."""
        self.emit("verdict.recorded", _compact(claimId=claim_id, status=status, sourceId=source_id,
                                               relationship=relationship, method=method, note=note, backend=backend))

    # ----------------------------------------------------------- tools, sources

    def tool(self, name: str, *, say: Optional[str] = None, call_id: Optional[str] = None) -> "ToolCall":
        """Context manager: ``tool.started`` on enter, ``tool.finished`` or ``tool.failed`` (then re-raise) on exit."""
        return ToolCall(self, name, say=say, call_id=call_id or uuid.uuid4().hex[:12])

    def tool_started(self, name: str, *, say: Optional[str] = None, call_id: Optional[str] = None) -> None:
        self.emit("tool.started", _compact(name=name, say=say, callId=call_id))

    def tool_finished(self, name: Optional[str] = None, *, call_id: Optional[str] = None, error: Optional[str] = None) -> None:
        """``tool.finished``, or ``tool.failed`` when ``error`` is given."""
        if error is None:
            self.emit("tool.finished", _compact(name=name, callId=call_id))
        else:
            self.emit("tool.failed", _compact(name=name, callId=call_id, error=error))

    def source(self, id: str, *, title: Optional[str] = None, url: Optional[str] = None,
               evidence: Optional[str] = None, **extra: Any) -> None:
        """Record an evidence source (``artifact`` of kind ``source``). ``evidence`` is A, B, C or D (spec 2.4);
        any other value drops the event with a warning."""
        if evidence is not None and evidence not in EVIDENCE:
            self.run.project.office._transport.warn_once(
                "evidence", f"dropping source {id!r}: evidence must be one of A, B, C, D, not {evidence!r}")
            return
        source = _compact(id=id, title=title, url=url, evidence=evidence)
        source.update(extra)
        self.emit("artifact", {"kind": "source", "source": source})

    def _target(self, to: Union[str, "Agent", None]) -> Any:
        """Agent id for ``to``; a target handle is registered first so it keeps its name.

        Anything else is passed through unchanged; the transport drops the event if it is invalid.
        """
        if isinstance(to, str):
            handle = self.run._agents.get(to)
            if handle is None:
                return to
            to = handle
        if not isinstance(to, Agent):
            return to
        to.ensure_registered()
        return to.id

    def __repr__(self) -> str:
        return f"Agent(id={self.id!r}, name={self.name!r})"


class ToolCall:
    """Returned by ``Agent.tool``; usable with ``with`` and ``async with``."""

    def __init__(self, agent: Agent, name: str, *, say: Optional[str], call_id: str) -> None:
        self.agent = agent
        self.name = name
        self.say = say
        self.call_id = call_id

    def __enter__(self) -> "ToolCall":
        self.agent.tool_started(self.name, say=self.say, call_id=self.call_id)
        return self

    def __exit__(self, exc_type: Optional[Type[BaseException]], exc: Optional[BaseException], tb: Optional[TracebackType]) -> None:
        error = None if exc_type is None else (str(exc) or exc_type.__name__)
        self.agent.tool_finished(self.name, call_id=self.call_id, error=error)

    async def __aenter__(self) -> "ToolCall":
        return self.__enter__()

    async def __aexit__(self, exc_type: Optional[Type[BaseException]], exc: Optional[BaseException], tb: Optional[TracebackType]) -> None:
        self.__exit__(exc_type, exc, tb)
