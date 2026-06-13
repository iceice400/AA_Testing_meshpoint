from __future__ import annotations

import asyncio
import logging
from typing import Optional

from src.analytics.topology_graph import TopologyGraph
from src.config import StormGuardConfig, TopologyRelayConfig
from src.models.packet import Packet, PacketType
from src.relay.channel_budget import ChannelBudget, build_channel_budget
from src.relay.dedup_filter import DeduplicationFilter
from src.relay.node_id import normalize_node_id, validate_node_ids
from src.relay.rate_limiter import RateLimiter
from src.relay.storm_guard import StormGuard
from src.relay.topology_relay import (
    compute_listen_delay_ms,
    is_priority_source,
    should_suppress_broadcast,
)

logger = logging.getLogger(__name__)

RELAY_WORTHY_TYPES = {
    PacketType.TEXT,
    PacketType.POSITION,
    PacketType.TELEMETRY,
    PacketType.NODEINFO,
}

BROADCAST_ADDR_MESHTASTIC = "ffffffff"
BROADCAST_ADDR_MESHCORE = "ffff"


class RelayDecision:
    """Encapsulates the decision of whether to relay a packet."""

    def __init__(self, should_relay: bool, reason: str):
        self.should_relay = should_relay
        self.reason = reason


class RelayManager:
    """Smart relay engine that decides which packets to rebroadcast.

    Applies multiple filters to prevent flooding:
    - Storm guard quarantine (in-memory)
    - Blocklist (persistent YAML)
    - Deduplication: skip packets already seen
    - Topology-aware suppression and listen-before-relay (optional)
    - Rate limiting: enforce max TX per minute
    - Per-channel ToA budget throttle
    - Hop filtering: don't relay packets with 0 hops remaining
    - Type filtering: only relay useful packet types
    - Signal filtering: don't relay strong signals (nearby nodes)
    - Destination filtering: never relay unicast packets addressed to us

    The actual transmission is handled by an external radio
    (SX1262 via meshtastic-python serial interface) or native SX1302.
    """

    def __init__(
        self,
        max_relay_per_minute: int = 20,
        burst_size: int = 5,
        min_relay_rssi: float = -110.0,
        max_relay_rssi: float = -50.0,
        enabled: bool = False,
        *,
        blocklist: list[str] | None = None,
        priority_list: list[str] | None = None,
        dedup_ttl_seconds: int = 300,
        storm_guard: StormGuard | None = None,
        channel_budget: ChannelBudget | None = None,
        topology_graph: TopologyGraph | None = None,
        topology_relay: TopologyRelayConfig | None = None,
    ):
        self._dedup = DeduplicationFilter(ttl_seconds=float(dedup_ttl_seconds))
        self._limiter = RateLimiter(max_relay_per_minute, burst_size)
        self._min_rssi = min_relay_rssi
        self._max_rssi = max_relay_rssi
        self._enabled = enabled
        self._blocklist = self._normalize_id_set(blocklist or [])
        self._priority_list = self._normalize_id_set(priority_list or [])
        self._storm_guard = storm_guard
        self._channel_budget = channel_budget
        self._topology_graph = topology_graph or TopologyGraph()
        self._topology_relay = topology_relay or TopologyRelayConfig()
        self._local_node_hex: str | None = None
        self._relay_count = 0
        self._rejected_count = 0
        self._rejection_reasons: dict[str, int] = {}
        self._deferred_cancelled = 0
        self._pending_relays: dict[str, asyncio.Task] = {}
        self._transmit_fn: Optional[callable] = None

    @staticmethod
    def _normalize_id_set(node_ids: list[str]) -> set[str]:
        return {
            normalize_node_id(node_id)
            for node_id in node_ids
            if normalize_node_id(node_id)
        }

    @staticmethod
    def _packet_key(packet: Packet) -> str:
        return f"{packet.source_id}:{packet.packet_id}"

    @property
    def storm_guard(self) -> StormGuard | None:
        return self._storm_guard

    @property
    def channel_budget(self) -> ChannelBudget | None:
        return self._channel_budget

    @property
    def topology_graph(self) -> TopologyGraph:
        return self._topology_graph

    def set_local_node_id(self, node_hex: str) -> None:
        """Skip relay for unicast packets addressed to this Meshpoint."""
        self._local_node_hex = node_hex.lower()

    @property
    def enabled(self) -> bool:
        return self._enabled

    @enabled.setter
    def enabled(self, value: bool) -> None:
        self._enabled = value
        logger.info("Relay %s", "enabled" if value else "disabled")

    def set_transmit_function(self, fn: callable) -> None:
        """Register the function used to transmit relay packets."""
        self._transmit_fn = fn

    def reload_filters(
        self,
        *,
        blocklist: list[str] | None = None,
        priority_list: list[str] | None = None,
        dedup_ttl_seconds: int | None = None,
        channel_throttle_percent: dict[str, float] | None = None,
        region: str | None = None,
    ) -> None:
        """Apply relay filter changes without a full service restart."""
        if blocklist is not None:
            self._blocklist = self._normalize_id_set(validate_node_ids(blocklist))
        if priority_list is not None:
            self._priority_list = self._normalize_id_set(
                validate_node_ids(priority_list)
            )
        if dedup_ttl_seconds is not None:
            self._dedup = DeduplicationFilter(ttl_seconds=float(dedup_ttl_seconds))
        if self._channel_budget is not None and (
            channel_throttle_percent is not None or region is not None
        ):
            self._channel_budget.reload(
                throttle_percent=channel_throttle_percent,
                region=region,
            )

    def reload_storm_guard(self, config: StormGuardConfig) -> None:
        """Hot-reload storm guard thresholds from updated relay config."""
        if self._storm_guard is not None:
            self._storm_guard.update_config(config)

    def reload_topology(self, config: TopologyRelayConfig) -> None:
        """Hot-reload topology-aware relay settings."""
        self._topology_relay = config

    def evaluate(self, packet: Packet) -> RelayDecision:
        """Decide whether a captured packet should be relayed."""
        if not self._enabled:
            return RelayDecision(False, "relay_disabled")

        source = normalize_node_id(packet.source_id)

        if self._storm_guard and self._storm_guard.is_quarantined(source):
            return RelayDecision(False, "storm_quarantine")

        if source and source in self._blocklist:
            return RelayDecision(False, "blocklisted")

        if self._dedup.is_duplicate(packet.source_id, packet.packet_id):
            self._cancel_pending_relay(packet)
            return RelayDecision(False, "duplicate")

        if packet.hop_limit <= 0:
            return RelayDecision(False, "no_hops_remaining")

        dest = (packet.destination_id or "").lower()
        if (
            self._local_node_hex
            and dest == self._local_node_hex
            and dest not in (BROADCAST_ADDR_MESHTASTIC, BROADCAST_ADDR_MESHCORE)
        ):
            return RelayDecision(False, "dest_local")

        if packet.packet_type not in RELAY_WORTHY_TYPES:
            return RelayDecision(False, "non_relayable_type")

        if packet.signal:
            if packet.signal.rssi > self._max_rssi:
                return RelayDecision(False, "signal_too_strong")
            if packet.signal.rssi < self._min_rssi:
                return RelayDecision(False, "signal_too_weak")

        if self._channel_budget is not None and not self._channel_budget.check_packet(
            packet
        ):
            return RelayDecision(False, "channel_throttled")

        topo = self._topology_relay
        if (
            topo.enabled
            and topo.suppression_enabled
            and not is_priority_source(packet, self._priority_list)
            and should_suppress_broadcast(
                self._topology_graph,
                packet,
                min_neighbors=topo.suppression_min_neighbors,
                overlap_percent=topo.suppression_overlap_percent,
                max_age_seconds=float(topo.graph_max_age_seconds),
            )
        ):
            return RelayDecision(False, "topology_redundant")

        if source and source in self._priority_list:
            if self._limiter.allow_priority():
                return RelayDecision(True, "approved_priority")
            return RelayDecision(False, "rate_limited")

        if not self._limiter.allow():
            return RelayDecision(False, "rate_limited")

        return RelayDecision(True, "approved")

    def _relay_delay_ms(self, packet: Packet, reason: str) -> int:
        topo = self._topology_relay
        if not topo.enabled or topo.listen_window_ms <= 0:
            return 0
        if is_priority_source(packet, self._priority_list):
            return 0
        if reason == "approved_priority":
            return 0
        return compute_listen_delay_ms(
            self._topology_graph,
            packet,
            base_ms=topo.listen_window_ms,
            max_ms=topo.listen_window_max_ms,
            max_age_seconds=float(topo.graph_max_age_seconds),
        )

    def _cancel_pending_relay(self, packet: Packet) -> None:
        key = self._packet_key(packet)
        task = self._pending_relays.pop(key, None)
        if task is None:
            return
        task.cancel()
        self._deferred_cancelled += 1

    async def process_packet(self, packet: Packet) -> None:
        """Evaluate and optionally relay a packet."""
        if self._storm_guard:
            self._storm_guard.observe(packet)

        decision = self.evaluate(packet)

        if decision.should_relay:
            delay_ms = self._relay_delay_ms(packet, decision.reason)
            if delay_ms > 0:
                await self._schedule_relay(packet, delay_ms)
            else:
                await self._execute_relay(packet)
        else:
            self._rejected_count += 1
            self._rejection_reasons[decision.reason] = (
                self._rejection_reasons.get(decision.reason, 0) + 1
            )
            logger.debug(
                "Relay rejected [%s]: %s from %s",
                decision.reason,
                packet.packet_id,
                packet.source_id,
            )

    async def _schedule_relay(self, packet: Packet, delay_ms: int) -> None:
        key = self._packet_key(packet)
        existing = self._pending_relays.pop(key, None)
        if existing is not None:
            existing.cancel()

        async def _deferred() -> None:
            try:
                await asyncio.sleep(delay_ms / 1000.0)
                if packet.hop_limit <= 0:
                    return
                source = normalize_node_id(packet.source_id)
                if source and source in self._priority_list:
                    if not self._limiter.allow_priority():
                        return
                elif not self._limiter.allow():
                    return
                await self._execute_relay(packet)
            except asyncio.CancelledError:
                raise
            finally:
                self._pending_relays.pop(key, None)

        self._pending_relays[key] = asyncio.create_task(
            _deferred(),
            name=f"relay-defer-{packet.packet_id}",
        )

    async def _execute_relay(self, packet: Packet) -> None:
        await self._relay(packet)
        self._relay_count += 1
        if self._channel_budget is not None:
            self._channel_budget.record_packet(packet)

    async def _relay(self, packet: Packet) -> None:
        """Transmit a relay packet via the attached radio.

        The registered transmit function may be either synchronous
        (legacy USB-companion path that calls a blocking serial API)
        or asynchronous (native onboard SX1302 path that schedules
        through asyncio). We detect at call time and dispatch
        accordingly so both backends share the same RelayManager.
        """
        if self._transmit_fn is None:
            logger.warning("No transmit function registered for relay")
            return

        logger.info(
            "RELAY [%s] %s -> %s (type=%s, rssi=%.1f)",
            packet.protocol.value,
            packet.source_id,
            packet.destination_id,
            packet.packet_type.value,
            packet.signal.rssi if packet.signal else 0,
        )

        try:
            if asyncio.iscoroutinefunction(self._transmit_fn):
                await self._transmit_fn(packet)
            else:
                # Sync transmit (legacy USB-companion path) blocks on
                # serial I/O, so it must run off the event loop.
                await asyncio.to_thread(self._transmit_fn, packet)
        except Exception:
            logger.exception("Relay transmission failed")

    def get_stats(self) -> dict:
        stats = {
            "enabled": self._enabled,
            "relayed": self._relay_count,
            "rejected": self._rejected_count,
            "rejection_reasons": dict(self._rejection_reasons),
            "dedup_cache_size": self._dedup.size,
            "rate_remaining": self._limiter.remaining_capacity,
            "current_rate": self._limiter.current_rate,
            "blocklist_count": len(self._blocklist),
            "priority_count": len(self._priority_list),
            "deferred_cancelled": self._deferred_cancelled,
            "pending_relay_count": len(self._pending_relays),
        }
        if self._channel_budget is not None:
            stats["channel_budget"] = self._channel_budget.summary()
        if self._storm_guard is not None and self._storm_guard.enabled:
            stats["storm_quarantine_count"] = len(self._storm_guard.snapshot())
        topo = self._topology_relay
        if topo.enabled:
            stats["topology_relay"] = {
                "enabled": topo.enabled,
                "listen_window_ms": topo.listen_window_ms,
                "suppression_enabled": topo.suppression_enabled,
                "graph": self._topology_graph.snapshot_stats(),
            }
        return stats


def build_relay_manager(
    relay_cfg,
    *,
    region: str,
    default_sf: int,
    default_bw_khz: float,
    default_preamble: int = 16,
    topology_graph: TopologyGraph | None = None,
) -> RelayManager:
    """Construct a relay manager from ``RelayConfig`` plus radio defaults."""
    storm = StormGuard(relay_cfg.storm_guard)
    budget = build_channel_budget(
        throttle_percent=relay_cfg.channel_throttle_percent or None,
        region=region,
        default_sf=default_sf,
        default_bw_khz=default_bw_khz,
        default_preamble=default_preamble,
    )
    graph = topology_graph or TopologyGraph(
        max_edge_age_seconds=float(relay_cfg.topology.graph_max_age_seconds),
    )
    return RelayManager(
        enabled=relay_cfg.enabled,
        max_relay_per_minute=relay_cfg.max_relay_per_minute,
        burst_size=relay_cfg.burst_size,
        min_relay_rssi=relay_cfg.min_relay_rssi,
        max_relay_rssi=relay_cfg.max_relay_rssi,
        blocklist=list(relay_cfg.blocklist or []),
        priority_list=list(relay_cfg.priority_list or []),
        dedup_ttl_seconds=relay_cfg.dedup_ttl_seconds,
        storm_guard=storm,
        channel_budget=budget,
        topology_graph=graph,
        topology_relay=relay_cfg.topology,
    )
