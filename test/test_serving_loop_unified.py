"""One serving loop, resolved through one accessor.

The dashboard latched "the loop to hand cross-thread work to" in three separate
places under three names: a field for the coalesced slots broadcast, a second for
off-loop websocket sends, and a third inside the ring-log handler. They held the
same loop, so nothing was broken -- but they are three answers to one question,
they can be updated independently, and a caller that finds ITS copy unset drops
the work silently rather than raising.

These tests pin the collapsed shape: ``DashboardState.serving_loop`` is the single
resolver, and the ratchet at the bottom fails if a second latched copy reappears.
"""
from __future__ import annotations

import asyncio
import collections
import logging
import re
from pathlib import Path
from unittest.mock import AsyncMock, MagicMock

import pytest

from kiro_crew.dashboard import state as state_mod
from kiro_crew.dashboard.handlers import updates
from kiro_crew.dashboard.state import DashboardState
from kiro_crew.history import ConversationLog


def _make_state(tmp_path) -> DashboardState:
    sessions = MagicMock(count=0)
    sessions.get_pid = MagicMock(return_value=None)
    sessions.remove = AsyncMock()
    return DashboardState(
        sessions=sessions,
        crons=MagicMock(list_jobs=MagicMock(return_value=[]), status=MagicMock(return_value={})),
        lessons=MagicMock(load_all=MagicMock(return_value=[])),
        start_time=0.0,
        conversation_log=ConversationLog(base_dir=tmp_path),
    )


@pytest.mark.asyncio
async def test_bind_wins_over_lazy_latching(tmp_path) -> None:
    """A bound loop is authoritative: the accessor never re-derives one."""
    state = _make_state(tmp_path)
    sentinel = MagicMock(name="loop-bound-at-startup")
    state.bind_serving_loop(sentinel)

    # Read from a real running loop; the bound value must still win, otherwise
    # startup's authoritative answer could be overwritten by whoever reads first.
    assert state.serving_loop is sentinel


@pytest.mark.asyncio
async def test_lazy_latch_when_nothing_bound(tmp_path) -> None:
    """A state whose startup never ran still resolves a loop when read from one."""
    state = _make_state(tmp_path)
    state._serving_loop = None

    assert state.serving_loop is asyncio.get_running_loop()
    # And it sticks, so a later off-loop caller has a target.
    assert state._serving_loop is asyncio.get_running_loop()


def test_unknowable_loop_is_none_not_a_guess(tmp_path) -> None:
    """Off the loop with nothing bound, the accessor admits it does not know."""
    state = _make_state(tmp_path)
    state._serving_loop = None

    assert state.serving_loop is None


@pytest.mark.asyncio
async def test_ws_hop_and_slots_coalescer_share_one_loop(tmp_path) -> None:
    """The two in-state consumers resolve the SAME object, not two copies."""
    state = _make_state(tmp_path)
    state._serving_loop = None
    ws = MagicMock(closed=False)
    ws.send_str = AsyncMock()
    ws.get = MagicMock(return_value=True)

    state.register_ws(ws)  # on the loop
    latched = state._serving_loop
    assert latched is asyncio.get_running_loop()

    # The slots coalescer must read that same field rather than latch its own.
    state.push_slots_update()
    assert state._serving_loop is latched


@pytest.mark.asyncio
async def test_log_handler_uses_the_states_loop(tmp_path) -> None:
    """The ring-log handler keeps no loop; it asks the state at emit time.

    emit() runs on arbitrary threads, so this is the surface most likely to
    re-grow its own copy.
    """
    ring: collections.deque[str] = collections.deque(maxlen=4)
    handler = updates._RingLogHandler(ring)
    handler.setFormatter(logging.Formatter("%(message)s"))
    ws = MagicMock()
    ws.send_str = AsyncMock()
    state = MagicMock()
    state._ws_log_subscribers = {ws}
    state.serving_loop = MagicMock()
    handler.set_state(state)

    handler.emit(
        logging.LogRecord("kiro_crew", logging.INFO, __file__, 1, "hello", None, None)
    )

    assert state.serving_loop.call_soon_threadsafe.called, (
        "the handler did not route its fan-out through the state's serving loop"
    )


def test_only_one_latched_serving_loop_field_remains() -> None:
    """Ratchet: a second latched copy of the loop must not reappear.

    Matches assignments of a running loop into an instance attribute across the
    two modules that had them. `_serving_loop` is the one permitted sink; anything
    else means the duplication this collapsed has grown back, which is invisible
    until two copies disagree at runtime.

    The match must END at the loop call: ``self._x = get_running_loop()`` stores
    the loop, whereas ``self._timer = get_running_loop().call_later(...)`` stores
    a timer handle and is not a second copy of the loop.
    """
    pattern = re.compile(
        r"self\.(_[A-Za-z0-9_]+)\s*=\s*(?:self\._running_loop\(\)"
        r"|asyncio\.get_running_loop\(\)"
        r"|asyncio\.get_event_loop\(\))\s*(?:#.*)?$",
        re.MULTILINE,
    )
    offenders: dict[str, set[str]] = {}
    for mod in (state_mod, updates):
        src = Path(mod.__file__).read_text(encoding="utf-8")
        names = {m.group(1) for m in pattern.finditer(src)} - {"_serving_loop"}
        if names:
            offenders[Path(mod.__file__).name] = names

    assert not offenders, (
        "a second latched serving-loop field reappeared: "
        f"{offenders} -- route it through DashboardState.serving_loop instead"
    )
