"""Rate-limited active traceroute polling for topology refresh."""

from __future__ import annotations

import asyncio
import logging
import time
from dataclasses import dataclass, field
from typing import Any, Callable, Optional

logger = logging.getLogger(__name__)

# Meshtastic 2.5.1+ minimum spacing between traceroute transmissions.
FIRMWARE_TR_LIMIT_S = 30.0

_ROUTER_ROLES = frozenset({"router", "repeater", "2", "4"})


@dataclass
class TopologyPollStatus:
    enabled: bool
    poll_interval_minutes: int
    max_polls_per_cycle: int
    last_cycle_at: Optional[float] = None
    last_cycle_count: int = 0
    last_error: Optional[str] = None
    cooldown_nodes: dict[str, float] = field(default_factory=dict)

    def to_dict(self) -> dict[str, Any]:
        return {
            "enabled": self.enabled,
            "poll_interval_minutes": self.poll_interval_minutes,
            "max_polls_per_cycle": self.max_polls_per_cycle,
            "last_cycle_at": self.last_cycle_at,
            "last_cycle_count": self.last_cycle_count,
            "last_error": self.last_error,
            "cooldown_count": len(self.cooldown_nodes),
        }


class TopologyPoller:
    """Fire Meshtastic traceroute requests to stale router nodes."""

    def __init__(
        self,
        *,
        enabled: bool = False,
        poll_interval_minutes: int = 15,
        max_polls_per_cycle: int = 10,
        send_traceroute: Optional[Callable[[str], Any]] = None,
        list_targets: Optional[Callable[[], Any]] = None,
    ) -> None:
        self._enabled = enabled
        self._interval_s = max(60, poll_interval_minutes * 60)
        self._max_polls = max(1, max_polls_per_cycle)
        self._send = send_traceroute
        self._list_targets = list_targets
        self._last_poll: dict[str, float] = {}
        self._status = TopologyPollStatus(
            enabled=enabled,
            poll_interval_minutes=poll_interval_minutes,
            max_polls_per_cycle=max_polls_per_cycle,
            cooldown_nodes=self._last_poll,
        )
        self._task: Optional[asyncio.Task] = None
        self._running = False

    @property
    def status(self) -> TopologyPollStatus:
        self._status.cooldown_nodes = dict(self._last_poll)
        return self._status

    def start(self) -> None:
        if not self._enabled or self._task is not None:
            return
        self._running = True
        self._task = asyncio.create_task(self._loop(), name="topology-poller")

    async def stop(self) -> None:
        self._running = False
        if self._task is not None:
            self._task.cancel()
            try:
                await self._task
            except asyncio.CancelledError:
                pass
            self._task = None

    async def trace_node(self, node_id: str, *, force: bool = False) -> dict[str, Any]:
        """Send one traceroute to a specific node (operator or smart-poller)."""
        if self._send is None:
            return {"success": False, "error": "TX unavailable", "node_id": node_id}

        now = time.time()
        last = self._last_poll.get(node_id, 0.0)
        if not force and (now - last) < self._interval_s:
            return {
                "success": False,
                "skipped": True,
                "node_id": node_id,
                "cooldown_remaining_s": round(self._interval_s - (now - last)),
            }

        try:
            result = await self._send(node_id)
            ok = getattr(result, "success", False)
            if ok:
                self._last_poll[node_id] = now
            err = None if ok else getattr(result, "error", "send failed")
            return {
                "success": ok,
                "node_id": node_id,
                "error": err,
            }
        except Exception as exc:
            return {"success": False, "node_id": node_id, "error": str(exc)}

    async def poll_now(self, *, force: bool = False) -> dict[str, Any]:
        if self._send is None or self._list_targets is None:
            return {"polled": 0, "error": "TX or node list unavailable"}

        try:
            targets = await self._list_targets()
        except Exception as exc:
            self._status.last_error = str(exc)
            return {"polled": 0, "error": str(exc)}

        polled = 0
        skipped = 0
        errors: list[str] = []
        now = time.time()

        for node_id in targets:
            if polled >= self._max_polls:
                break
            last = self._last_poll.get(node_id, 0.0)
            if not force and (now - last) < self._interval_s:
                skipped += 1
                continue
            try:
                result = await self._send(node_id)
                if getattr(result, "success", False):
                    self._last_poll[node_id] = now
                    polled += 1
                    await asyncio.sleep(max(FIRMWARE_TR_LIMIT_S, 0.8))
                else:
                    err = getattr(result, "error", "send failed")
                    errors.append(f"{node_id}: {err}")
            except Exception as exc:
                errors.append(f"{node_id}: {exc}")

        self._status.last_cycle_at = now
        self._status.last_cycle_count = polled
        self._status.last_error = errors[0] if errors else None
        logger.info("Topology poll: %d sent, %d skipped", polled, skipped)
        return {
            "polled": polled,
            "skipped": skipped,
            "errors": errors[:5],
        }

    async def _loop(self) -> None:
        while self._running:
            try:
                await self.poll_now(force=False)
            except asyncio.CancelledError:
                raise
            except Exception:
                logger.exception("Topology poller cycle failed")
            await asyncio.sleep(self._interval_s)

    @staticmethod
    def is_router_role(role: Any) -> bool:
        if role is None:
            return False
        text = str(role).lower()
        if text in _ROUTER_ROLES:
            return True
        try:
            return int(role) in (2, 4)
        except (TypeError, ValueError):
            return False
