from __future__ import annotations

import json
import logging
from datetime import datetime, timedelta, timezone

from src.models.packet import Packet, PacketType, Protocol
from src.models.signal import SignalMetrics
from src.storage.database import DatabaseManager

logger = logging.getLogger(__name__)


class PacketRepository:
    """CRUD operations for captured mesh packets."""

    def __init__(self, db: DatabaseManager):
        self._db = db

    async def insert(self, packet: Packet) -> None:
        payload_json = (
            json.dumps(packet.decoded_payload)
            if packet.decoded_payload
            else None
        )
        await self._db.execute(
            """
            INSERT INTO packets (
                packet_id, source_id, destination_id, protocol,
                packet_type, hop_limit, hop_start, channel_hash,
                want_ack, via_mqtt, relay_node, decoded_payload, decrypted,
                rssi, snr, frequency_mhz, spreading_factor,
                bandwidth_khz, capture_source, timestamp
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            """,
            (
                packet.packet_id, packet.source_id,
                packet.destination_id, packet.protocol.value,
                packet.packet_type.value, packet.hop_limit,
                packet.hop_start, packet.channel_hash,
                int(packet.want_ack), int(packet.via_mqtt),
                packet.relay_node, payload_json, int(packet.decrypted),
                packet.signal.rssi if packet.signal else None,
                packet.signal.snr if packet.signal else None,
                packet.signal.frequency_mhz if packet.signal else None,
                packet.signal.spreading_factor if packet.signal else None,
                packet.signal.bandwidth_khz if packet.signal else None,
                packet.capture_source, packet.timestamp.isoformat(),
            ),
        )
        await self._db.commit()

    async def get_recent(self, limit: int = 100) -> list[Packet]:
        rows = await self._db.fetch_all(
            "SELECT * FROM packets ORDER BY timestamp DESC LIMIT ?",
            (limit,),
        )
        return [self._row_to_packet(r) for r in rows]

    async def get_signal_buckets(
        self,
        source_id: str,
        hours: float = 24,
        bucket_minutes: int = 15,
    ) -> list[dict]:
        """RSSI averages in fixed time buckets for sparkline charts."""
        since = (
            datetime.now(timezone.utc) - timedelta(hours=hours)
        ).isoformat()
        bucket_seconds = max(60, int(bucket_minutes) * 60)
        rows = await self._db.fetch_all(
            """
            SELECT
                datetime(
                    (CAST(strftime('%s', timestamp) AS INTEGER) / ?) * ?,
                    'unixepoch'
                ) AS bucket,
                AVG(rssi) AS rssi_avg,
                COUNT(*) AS packet_count
            FROM packets
            WHERE source_id = ? AND rssi IS NOT NULL AND timestamp >= ?
            GROUP BY bucket
            ORDER BY bucket ASC
            """,
            (bucket_seconds, bucket_seconds, source_id, since),
        )
        return [
            {
                "bucket": f"{row['bucket']}Z" if row["bucket"] else "",
                "rssi_avg": round(row["rssi_avg"], 1) if row["rssi_avg"] is not None else None,
                "packet_count": row["packet_count"] or 0,
            }
            for row in rows
        ]

    async def get_signal_history(
        self,
        source_id: str,
        limit: int = 500,
        hours: float | None = 24,
    ) -> list[dict]:
        """RSSI/SNR samples from any packet by this node, oldest-first."""
        if hours is not None and hours > 0:
            since = (
                datetime.now(timezone.utc) - timedelta(hours=hours)
            ).isoformat()
            rows = await self._db.fetch_all(
                """
                SELECT timestamp, rssi, snr FROM packets
                WHERE source_id = ? AND rssi IS NOT NULL AND timestamp >= ?
                ORDER BY timestamp ASC
                LIMIT ?
                """,
                (source_id, since, limit),
            )
        else:
            rows = await self._db.fetch_all(
                """
                SELECT timestamp, rssi, snr FROM packets
                WHERE source_id = ? AND rssi IS NOT NULL
                ORDER BY timestamp ASC
                LIMIT ?
                """,
                (source_id, limit),
            )
        return [
            {
                "timestamp": row["timestamp"],
                "rssi": row["rssi"],
                "snr": row.get("snr"),
            }
            for row in rows
        ]

    async def get_source_id_by_packet_id(self, packet_id: str) -> str:
        if not packet_id:
            return ""
        row = await self._db.fetch_one(
            "SELECT source_id FROM packets WHERE packet_id = ? LIMIT 1",
            (packet_id,),
        )
        return row["source_id"] if row else ""

    async def get_meta_by_packet_id(self, packet_id: str) -> dict:
        """Return source_id and hop_count for a stored packet (message enrichment)."""
        if not packet_id:
            return {}
        row = await self._db.fetch_one(
            """
            SELECT source_id, hop_start, hop_limit
            FROM packets WHERE packet_id = ? LIMIT 1
            """,
            (packet_id,),
        )
        if not row:
            return {}
        hop_start = row.get("hop_start", 0) or 0
        hop_limit = row.get("hop_limit", 0) or 0
        hop_count = max(0, hop_start - hop_limit) if hop_start > 0 else None
        return {
            "source_id": row.get("source_id") or "",
            "hop_count": hop_count,
        }

    async def get_by_source(
        self, source_id: str, limit: int = 100
    ) -> list[Packet]:
        rows = await self._db.fetch_all(
            "SELECT * FROM packets WHERE source_id = ? ORDER BY timestamp DESC LIMIT ?",
            (source_id, limit),
        )
        return [self._row_to_packet(r) for r in rows]

    async def get_count(self) -> int:
        row = await self._db.fetch_one("SELECT COUNT(*) as cnt FROM packets")
        return row["cnt"] if row else 0

    async def get_count_since(self, since: datetime) -> int:
        row = await self._db.fetch_one(
            "SELECT COUNT(*) as cnt FROM packets WHERE timestamp >= ?",
            (since.isoformat(),),
        )
        return row["cnt"] if row else 0

    async def get_protocol_distribution(self) -> dict[str, int]:
        rows = await self._db.fetch_all(
            "SELECT protocol, COUNT(*) as cnt FROM packets GROUP BY protocol"
        )
        return {r["protocol"]: r["cnt"] for r in rows}

    async def get_type_distribution(self) -> dict[str, int]:
        rows = await self._db.fetch_all(
            "SELECT packet_type, COUNT(*) as cnt FROM packets GROUP BY packet_type"
        )
        return {r["packet_type"]: r["cnt"] for r in rows}

    async def get_hourly_traffic(self, hours: int = 24) -> list[dict]:
        """Protocol counts grouped by UTC hour for the Stats 24h view."""
        since = (
            datetime.now(timezone.utc) - timedelta(hours=hours)
        ).isoformat()
        rows = await self._db.fetch_all(
            """
            SELECT
                strftime('%Y-%m-%dT%H:00:00', timestamp) AS hour_start,
                SUM(CASE WHEN protocol = 'meshtastic' THEN 1 ELSE 0 END) AS meshtastic,
                SUM(CASE WHEN protocol = 'meshcore' THEN 1 ELSE 0 END) AS meshcore,
                COUNT(*) AS total
            FROM packets
            WHERE timestamp >= ?
            GROUP BY hour_start
            ORDER BY hour_start ASC
            """,
            (since,),
        )
        return [dict(row) for row in rows]

    async def get_hourly_modem_groups(self, hours: int = 24) -> list[dict]:
        """Per-hour modem buckets for duty-cycle estimates."""
        since = (
            datetime.now(timezone.utc) - timedelta(hours=hours)
        ).isoformat()
        rows = await self._db.fetch_all(
            """
            SELECT
                strftime('%Y-%m-%dT%H:00:00', timestamp) AS hour_start,
                spreading_factor AS sf,
                bandwidth_khz AS bw,
                COUNT(*) AS packet_count
            FROM packets
            WHERE timestamp >= ?
            GROUP BY hour_start, spreading_factor, bandwidth_khz
            """,
            (since,),
        )
        return [dict(row) for row in rows]

    async def get_topology_packets(
        self,
        since: str,
        *,
        limit: int = 500,
    ) -> list[dict]:
        """Recent topology-bearing packets within a time window."""
        rows = await self._db.fetch_all(
            """
            SELECT source_id, destination_id, packet_type, protocol, decoded_payload,
                   rssi, snr, timestamp
            FROM packets
            WHERE timestamp >= ?
              AND packet_type IN ('neighborinfo', 'traceroute', 'routing')
              AND decoded_payload IS NOT NULL
            ORDER BY timestamp DESC
            LIMIT ?
            """,
            (since, limit),
        )
        return [dict(row) for row in rows]

    async def get_coverage_aggregates(self, since: str) -> list[dict]:
        """Nodes with GPS plus packet RSSI aggregates for map coverage circles."""
        rows = await self._db.fetch_all(
            """
            SELECT
                n.node_id,
                n.long_name,
                n.short_name,
                n.protocol,
                n.latitude,
                n.longitude,
                COUNT(p.id) AS packet_count,
                AVG(p.rssi) AS avg_rssi,
                MAX(p.rssi) AS best_rssi
            FROM nodes n
            LEFT JOIN packets p
                ON p.source_id = n.node_id AND p.timestamp >= ?
            WHERE n.latitude IS NOT NULL AND n.longitude IS NOT NULL
            GROUP BY n.node_id
            """,
            (since,),
        )
        return [dict(row) for row in rows]

    async def get_node_packet_counts_since(self, since: str) -> list[dict]:
        """Packet counts and latest RSSI per source node in a window."""
        rows = await self._db.fetch_all(
            """
            SELECT source_id, protocol,
                   COUNT(*) AS packet_count,
                   MAX(rssi) AS latest_rssi
            FROM packets
            WHERE timestamp >= ?
            GROUP BY source_id, protocol
            """,
            (since,),
        )
        return [dict(row) for row in rows]

    async def get_channel_hash_counts_since(self, since: str) -> list[dict]:
        """Per-channel_hash packet counts for topology channel utilization."""
        rows = await self._db.fetch_all(
            """
            SELECT channel_hash, COUNT(*) AS packet_count
            FROM packets
            WHERE timestamp >= ?
            GROUP BY channel_hash
            ORDER BY packet_count DESC
            """,
            (since,),
        )
        return [dict(row) for row in rows]

    async def cleanup_old(self, max_retained: int) -> int:
        total = await self.get_count()
        if total <= max_retained:
            return 0
        excess = total - max_retained
        await self._db.execute(
            "DELETE FROM packets WHERE id IN (SELECT id FROM packets ORDER BY timestamp ASC LIMIT ?)",
            (excess,),
        )
        await self._db.commit()
        logger.info("Cleaned up %d old packets", excess)
        return excess

    @staticmethod
    def _row_to_packet(row: dict) -> Packet:
        signal = None
        if row.get("rssi") is not None:
            signal = SignalMetrics(
                rssi=row["rssi"],
                snr=row.get("snr", 0.0),
                frequency_mhz=row.get("frequency_mhz", 906.875),
                spreading_factor=row.get("spreading_factor", 11),
                bandwidth_khz=row.get("bandwidth_khz", 250.0),
            )

        decoded = None
        if row.get("decoded_payload"):
            decoded = json.loads(row["decoded_payload"])

        return Packet(
            packet_id=row["packet_id"],
            source_id=row["source_id"],
            destination_id=row["destination_id"],
            protocol=Protocol(row["protocol"]),
            packet_type=PacketType(row["packet_type"]),
            hop_limit=row.get("hop_limit", 0),
            hop_start=row.get("hop_start", 0),
            channel_hash=row.get("channel_hash", 0),
            want_ack=bool(row.get("want_ack", 0)),
            via_mqtt=bool(row.get("via_mqtt", 0)),
            relay_node=row.get("relay_node", 0),
            decoded_payload=decoded,
            decrypted=bool(row.get("decrypted", 0)),
            signal=signal,
            capture_source=row.get("capture_source", "unknown"),
            timestamp=datetime.fromisoformat(row["timestamp"]),
        )
