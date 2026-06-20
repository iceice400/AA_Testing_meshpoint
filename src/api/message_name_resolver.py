"""Resolve message display names from the live node roster."""

from __future__ import annotations

import logging
from typing import TYPE_CHECKING, Any

if TYPE_CHECKING:
    from src.storage.node_repository import NodeRepository
    from src.storage.packet_repository import PacketRepository
    from src.transmit.meshcore_tx_client import MeshCoreTxClient

logger = logging.getLogger(__name__)


class MessageNameResolver:
    """Look up current node names for messaging UI (not stored message rows)."""

    def __init__(
        self,
        node_repo: NodeRepository | None = None,
        meshcore_tx: MeshCoreTxClient | None = None,
        packet_repo: PacketRepository | None = None,
    ) -> None:
        self._node_repo = node_repo
        self._meshcore_tx = meshcore_tx
        self._packet_repo = packet_repo

    async def resolve(
        self,
        node_id: str,
        protocol: str = "",
        fallback: str = "",
    ) -> str:
        if node_id.startswith("broadcast:"):
            fb = (fallback or "").strip()
            if fb and fb.lower() != "broadcast":
                return fb
            return ""

        name = await self._lookup_meshtastic(node_id)
        if name:
            return name

        if protocol == "meshcore" or not protocol:
            name = await self._lookup_meshcore(node_id)
            if name:
                return name

        if fallback and not self._is_hex_only(fallback):
            return fallback
        return fallback or node_id

    async def _lookup_meshtastic(self, node_id: str) -> str:
        if not self._node_repo or node_id.startswith("broadcast:"):
            return ""
        try:
            for candidate in (node_id, node_id.upper(), node_id.lower()):
                node = await self._node_repo.get_by_id(candidate)
                if not node:
                    continue
                n = node if isinstance(node, dict) else node.to_dict()
                if n.get("protocol") == "meshcore":
                    continue
                name = n.get("long_name") or n.get("short_name") or ""
                if name and name.lower() != candidate.lower():
                    return name
        except Exception:
            logger.debug("Meshtastic name lookup failed for %s", node_id, exc_info=True)
        return ""

    async def _lookup_meshcore(self, node_id: str) -> str:
        if not self._meshcore_tx or not self._meshcore_tx.connected:
            return ""
        try:
            mc_contacts = await self._meshcore_tx.get_contacts()
            nid_lower = node_id.lower()
            for contact in mc_contacts:
                pk = contact.get("public_key", "").lower()
                name = contact.get("name", "")
                if not name or self._is_hex_only(name):
                    continue
                if pk.startswith(nid_lower) or nid_lower.startswith(pk[:8]):
                    return name
        except Exception:
            logger.debug("MeshCore name lookup failed for %s", node_id, exc_info=True)
        return ""

    @staticmethod
    def _is_hex_only(value: str) -> bool:
        try:
            int(value, 16)
            return len(value) >= 6
        except ValueError:
            return False

    async def apply_to_message_dict(self, message: dict[str, Any]) -> dict[str, Any]:
        out = dict(message)
        node_id = out.get("node_id", "")
        stored = (out.get("node_name") or "").strip()
        if node_id.startswith("broadcast:"):
            if stored and stored.lower() != "broadcast":
                out["node_name"] = stored
            else:
                out["node_name"] = await self._resolve_broadcast_sender(out)
        else:
            out["node_name"] = await self.resolve(
                node_id,
                out.get("protocol", ""),
                stored,
            )

        source_id = await self._resolve_source_id(out)
        if source_id:
            out["source_id"] = source_id
            sender_meta = await self.build_sender_meta(
                source_id,
                out.get("protocol", ""),
                out.get("node_name", ""),
                out.get("packet_id", ""),
                message_rssi=out.get("rssi"),
            )
            if sender_meta:
                out["sender_meta"] = sender_meta

        return out

    async def _resolve_source_id(self, message: dict[str, Any]) -> str:
        direction = message.get("direction", "")
        if direction == "sent":
            return ""

        node_id = message.get("node_id", "")
        pkt_id = message.get("packet_id") or ""

        if node_id.startswith("broadcast:"):
            if pkt_id and self._packet_repo:
                meta = await self._packet_repo.get_meta_by_packet_id(pkt_id)
                return meta.get("source_id") or ""
            return ""

        if direction in ("received", "overheard") and node_id:
            return node_id

        if pkt_id and self._packet_repo:
            meta = await self._packet_repo.get_meta_by_packet_id(pkt_id)
            return meta.get("source_id") or ""

        return node_id if node_id and not node_id.startswith("broadcast:") else ""

    async def build_sender_meta(
        self,
        source_id: str,
        protocol: str = "",
        display_name: str = "",
        packet_id: str = "",
        message_rssi: float | None = None,
    ) -> dict[str, Any]:
        """Compact sender info for message popovers (REST + WebSocket)."""
        if not source_id:
            return {}

        meta: dict[str, Any] = {
            "node_id": source_id,
            "display_name": display_name or source_id,
        }

        hop_count = None
        if packet_id and self._packet_repo:
            pkt_meta = await self._packet_repo.get_meta_by_packet_id(packet_id)
            hop_count = pkt_meta.get("hop_count")

        short_name = ""
        if self._node_repo:
            try:
                enriched = await self._node_repo.get_enriched_by_id(source_id)
                if enriched:
                    meta["display_name"] = (
                        display_name
                        or enriched.get("long_name")
                        or enriched.get("short_name")
                        or source_id
                    )
                    short_name = enriched.get("short_name") or ""
                    meta["last_heard"] = enriched.get("last_heard") or ""
                    if enriched.get("latest_rssi") is not None:
                        meta["latest_rssi"] = enriched.get("latest_rssi")
                    if enriched.get("latest_hops") is not None:
                        meta["latest_hops"] = enriched.get("latest_hops")
                    if enriched.get("latitude") is not None:
                        meta["latitude"] = enriched.get("latitude")
                    if enriched.get("longitude") is not None:
                        meta["longitude"] = enriched.get("longitude")
            except Exception:
                logger.debug(
                    "Sender meta lookup failed for %s", source_id, exc_info=True
                )

        if short_name:
            meta["short_name"] = short_name

        if hop_count is not None:
            meta["hop_count"] = hop_count
        elif message_rssi is not None and meta.get("latest_rssi") is None:
            meta["latest_rssi"] = message_rssi

        return meta

    async def _resolve_broadcast_sender(self, message: dict[str, Any]) -> str:
        pkt_id = message.get("packet_id") or ""
        if pkt_id and self._packet_repo:
            src = await self._packet_repo.get_source_id_by_packet_id(pkt_id)
            if src:
                return await self.resolve(
                    src,
                    message.get("protocol", ""),
                    src,
                )
        return ""

    async def apply_to_conversation_dict(self, conversation: dict[str, Any]) -> dict[str, Any]:
        out = dict(conversation)
        out["node_name"] = await self.resolve(
            out.get("node_id", ""),
            out.get("protocol", ""),
            out.get("node_name", ""),
        )
        return out
