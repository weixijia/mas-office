import json
import socket
import threading
import time
import warnings
from datetime import datetime
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import parse_qs, urlparse

import pytest

from mas_office import Office
from mas_office.transport import MAX_BODY_BYTES, HttpTransport


class Received(list):
    """Requests seen by the fake server; ``sizes`` holds each body's length in bytes."""


def sent_events(received, project="deals"):
    return [e for _, folder, _, events in received if folder == project for e in events]


@pytest.fixture
def server():
    received = Received()
    sizes = []

    class Handler(BaseHTTPRequestHandler):
        def do_POST(self):
            body = self.rfile.read(int(self.headers["Content-Length"]))
            sizes.append(len(body))
            query = parse_qs(urlparse(self.path).query)
            events = json.loads(body)
            received.append((urlparse(self.path).path, query["project"][0], self.headers["Content-Type"], events))
            payload = json.dumps({"accepted": len(events), "lastSeq": len(events)}).encode()
            self.send_response(200)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(payload)))
            self.end_headers()
            self.wfile.write(payload)

        def log_message(self, *args):
            pass

    httpd = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
    thread = threading.Thread(target=httpd.serve_forever, daemon=True)
    thread.start()
    received.sizes = sizes
    yield f"http://127.0.0.1:{httpd.server_address[1]}", received
    httpd.shutdown()
    httpd.server_close()


def test_http_transport_posts_ordered_batches(server):
    url, received = server
    with Office(url=url) as office:
        run = office.project("deals", title="Deals").run()
        agent = run.agent("finder", name="Finder")
        for i in range(20):
            agent.working(f"step {i}", progress=i)
        other = office.project("other").run()
        other.finish()
        run.finish()

    assert all(path == "/v0/events" and ctype == "application/json" for path, _, ctype, _ in received)
    deals = [e for _, project, _, events in received if project == "deals" for e in events]
    assert [e["type"] for e in deals] == ["run.started", "agent.registered"] + ["agent.status"] * 20 + ["run.finished"]
    assert [e["data"]["say"] for e in deals if e["type"] == "agent.status"] == [f"step {i}" for i in range(20)]
    assert all(e["v"] == "0.1" and "ts" in e and "seq" not in e for e in deals)
    assert deals[0]["data"]["title"] == "Deals"
    assert [e["type"] for _, project, _, events in received if project == "other" for e in events] == [
        "run.started", "run.finished"]


def free_port():
    with socket.socket() as s:
        s.bind(("127.0.0.1", 0))
        return s.getsockname()[1]


def test_http_failure_never_raises_and_warns_once():
    office = Office(url=f"http://127.0.0.1:{free_port()}")
    run = office.project("deals").run()
    with pytest.warns(RuntimeWarning, match="dropped") as record:
        run.lead.say("hello")
        office.flush()
        run.finish()
        office.close()
    assert len([w for w in record if issubclass(w.category, RuntimeWarning)]) == 1


def test_http_non_serialisable_event_is_dropped_and_worker_keeps_going(server):
    url, received = server
    office = Office(url=url)
    run = office.project("deals").run()
    agent = run.agent("finder")
    with pytest.warns(RuntimeWarning, match="not JSON-serialisable"):
        agent.source("s1", when=datetime.now())
    agent.say("after")
    started = time.monotonic()
    with warnings.catch_warnings():
        warnings.simplefilter("error")  # no delivery warning: nothing was lost in transit
        office.close()
    assert time.monotonic() - started < 2
    types = [e["type"] for e in sent_events(received)]
    assert types == ["run.started", "agent.registered", "message"]


def test_http_invalid_events_are_not_sent(server):
    url, received = server
    with Office(url=url) as office:
        run = office.project("deals").run()
        with pytest.warns(RuntimeWarning, match="data.to"):
            run.lead.handoff("Checker Bot")
        with pytest.warns(RuntimeWarning, match="data.text"):
            run.lead.say(None)
        run.finish()
    assert [e["type"] for e in sent_events(received)] == ["run.started", "run.finished"]


def test_http_worker_survives_an_unexpected_error(server, monkeypatch):
    url, received = server
    real_send = HttpTransport._send
    calls = []

    def flaky_send(self, batch):
        calls.append(len(batch))
        if len(calls) == 1:
            raise RuntimeError("boom")
        real_send(self, batch)

    monkeypatch.setattr(HttpTransport, "_send", flaky_send)
    office = Office(url=url)
    run = office.project("deals").run()
    started = time.monotonic()
    with pytest.warns(RuntimeWarning, match="boom"):
        office.flush()  # the first batch hits the error; bookkeeping still runs
    run.lead.say("second")
    office.close()
    assert time.monotonic() - started < 2
    assert [e["type"] for e in sent_events(received)] == ["message"]


def test_http_batches_stay_under_the_body_limit(server):
    url, received = server
    big = "x" * 300_000
    with Office(url=url) as office:
        run = office.project("deals").run()
        office.flush()
        for i in range(5):
            run.lead.say(f"{i}{big}")
        with pytest.warns(RuntimeWarning, match="at most"):
            run.lead.say("y" * MAX_BODY_BYTES)
        run.finish()
    events = sent_events(received)
    assert [e["type"] for e in events] == ["run.started"] + ["message"] * 5 + ["run.finished"]
    assert [e["data"]["text"][0] for e in events if e["type"] == "message"] == list("01234")
    assert all(size < MAX_BODY_BYTES for size in received.sizes)


def test_http_send_splits_one_project_run_by_bytes(monkeypatch):
    transport = HttpTransport("http://127.0.0.1:1")
    posts = []
    monkeypatch.setattr(transport, "_post", lambda folder, bodies: posts.append((folder, [len(b) for b in bodies])))
    body = b"x" * 300_000
    transport._send([("a", body)] * 5 + [("b", b"y")] + [("a", body)])
    assert posts == [("a", [300_000] * 3), ("a", [300_000] * 2), ("b", [1]), ("a", [300_000])]
    assert all(2 + sum(sizes) + len(sizes) - 1 < MAX_BODY_BYTES for _, sizes in posts)
    transport.close()
