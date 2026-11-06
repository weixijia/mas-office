"""A simulated staged team, so you can watch the panel without any framework or API key.

Team: two finders search in parallel (threads) → a checker raises and resolves a concern,
spawning a helper at runtime → a planner → the lead writes the result. All data is made up
and every URL points at example.com.
"""

from __future__ import annotations

import threading
import time
from pathlib import Path
from typing import Any, Callable, Dict

from .office import Agent, Office, Run

STRUCTURE: Dict[str, Any] = {
    "title": "Headphone deals",
    "version": 1,
    "topology": "staged",
    "lead": {"id": "lead", "name": "Lead", "emoji": "🧭", "job": "Write the shortlist", "serves": ["R1", "R2", "R3"]},
    "groups": [
        {"id": "A", "label": "Search", "after": None},
        {"id": "B", "label": "Check", "after": "A"},
        {"id": "C", "label": "Plan", "after": "B"},
    ],
    "roles": [
        {"id": "finder-a", "name": "Retail finder", "emoji": "🔎", "job": "Search UK retailers",
         "serves": ["R1"], "tools": ["web search"], "group": "A", "handsTo": "checker"},
        {"id": "finder-b", "name": "Market finder", "emoji": "🛒", "job": "Search marketplaces",
         "serves": ["R1"], "tools": ["web search"], "group": "A", "handsTo": "checker"},
        {"id": "checker", "name": "Catch checker", "emoji": "🛡️", "job": "Check each offer against R2 and R3",
         "serves": ["R2", "R3"], "tools": ["web search"], "group": "B", "handsTo": "planner"},
        {"id": "planner", "name": "Buy planner", "emoji": "🗓️", "job": "Order the options by value",
         "serves": ["R1"], "tools": [], "group": "C", "handsTo": "lead"},
    ],
}

TASK: Dict[str, Any] = {
    "summary": "Find the best price for new Sony WH-1000XM6 headphones in the UK.",
    "requirements": [
        {"id": "R1", "text": "Under £300 delivered"},
        {"id": "R2", "text": "New, not refurbished"},
        {"id": "R3", "text": "UK seller with a returns policy"},
    ],
}


def run_demo(workspace: str = "./runs", speed: float = 1.0, folder: str = "headphone-deals") -> Path:
    """Simulate a run (about 30 s at ``speed=1``) and return the project folder."""

    def pause(seconds: float) -> None:
        time.sleep(seconds / speed)

    with Office(workspace=workspace) as office:
        project = office.project(folder, title="Headphone deals", task=TASK)
        run = project.run(STRUCTURE)
        lead = run.lead
        pause(1.5)
        lead.say("Splitting the search between two finders")
        pause(1.5)

        threads = [
            threading.Thread(target=_finder, args=(run.agent("finder-a"), "Currys", "currys-xm6", 279, pause)),
            threading.Thread(target=_finder, args=(run.agent("finder-b"), "eBay", "ebay-xm6", 239, pause)),
        ]
        lead.working("Waiting for the finders", progress=20)
        for thread in threads:
            thread.start()
        for thread in threads:
            thread.join()

        _checker(run, pause)
        _planner(run.agent("planner"), pause)

        lead.working("Writing the shortlist", progress=80)
        pause(2)
        run.result(
            markdown=(
                "## Shortlist\n\n"
                "| Seller | Price | Condition | Meets |\n|---|---|---|---|\n"
                "| Currys | £279 | New | R1, R2, R3 |\n"
                "| eBay | £239 | Refurbished | R1 only |\n\n"
                "**Pick:** Currys at £279. The eBay unit is cheaper but refurbished, which breaks R2.\n\n"
                "_Demo data: prices and links are made up._"
            ),
            work=[
                {"by": "finder-a", "summary": "Searched 3 UK retailers; best new price **£279** at Currys."},
                {"by": "finder-b", "summary": "Searched 2 marketplaces; cheapest listing **£239** on eBay."},
                {"by": "checker", "summary": "Checked 2 offers; the eBay unit is refurbished (breaks R2)."},
                {"by": "price-verifier", "summary": "Confirmed the Currys price includes delivery."},
                {"by": "planner", "summary": "Ranked the offers by value against R1-R3."},
            ],
        )
        pause(1)
        run.finish("Shortlist ready")
    return Path(workspace) / folder


def _finder(agent: Agent, shop: str, source_id: str, price: int, pause: Callable[[float], None]) -> None:
    agent.working(f"Searching {shop}", progress=10)
    pause(2)
    with agent.tool("web_search", say=f"Searching {shop} for XM6"):
        pause(3)
    agent.working(f"Reading {shop} listings", progress=50)
    pause(2)
    agent.source(source_id, title=f"Sony WH-1000XM6 — {shop}", url=f"https://example.com/{source_id}",
                 evidence="A", price=f"£{price}")
    agent.say(f"Found it at £{price} on {shop}")
    pause(2)
    agent.handoff("checker")
    pause(1)
    agent.done(f"Handed £{price} offer over")


def _checker(run: Run, pause: Callable[[float], None]) -> None:
    checker = run.agent("checker")
    checker.working("Checking 2 offers", progress=20)
    pause(2)
    helper = run.agent("price-verifier", name="Price verifier", emoji="🧾", job="Confirm delivered prices",
                       parent=checker, hands_to="checker")
    helper.working("Checking Currys delivery cost", progress=30)
    with helper.tool("web_fetch"):
        pause(2)
    helper.handoff(checker, say="Price includes delivery")
    pause(1)
    helper.done("Price confirmed")
    checker.flag("eBay unit is refurbished — breaks R2", kind="concern")
    pause(3)
    checker.say("Kept eBay as a cheaper, marked option")
    checker.resolve()
    checker.working("Writing up the checks", progress=80)
    pause(1.5)
    checker.handoff("planner")
    pause(1)
    checker.done("2 offers checked")


def _planner(planner: Agent, pause: Callable[[float], None]) -> None:
    planner.working("Ranking offers by value", progress=30)
    pause(2)
    planner.say("Currys first, eBay as a marked fallback")
    pause(1.5)
    planner.handoff("lead")
    pause(1)
    planner.done("Ranking handed over")
