// ── Canonical Spark addressing ────────────────────────────────────────────────
// The ONE place node addresses live. Pure data, no Node built-ins, so this is
// safe to import from `"use client"` components as well as from the server —
// which is the point: the UI must render the address we actually connect to,
// never a hand-typed label that can drift out of sync with it.
//
// Since 2026-09-27 the dashboard reaches every node over **Tailscale**, not the
// LAN. Two reasons, both measured:
//
//  1. All four Sparks sit behind a TP-Link extender at 10.0.0.39 running in
//     REPEATER mode. It ARP/ND-proxies every Spark LAN IP with its own MAC
//     (ba:07:1d:0a:a2:4e), emits gratuitous broadcast ARP claiming them, and
//     MAC-translates in both directions — that MAC is invisible on the Sparks'
//     own wire. From the Mac this shows up as latency spikes 3ms → 190ms and
//     intermittent total loss, i.e. nodes that render OFFLINE while healthy.
//  2. The LAN addresses are DHCP leases with no reservations and they drift.
//     spark1 alone went 10.0.0.102 → 10.0.0.223, and .102 became an unrelated
//     device. Every historical "node is OFFLINE" bug in this repo traces back
//     to a baked-in address that had moved.
//
// Tailscale addresses are permanent for the life of the node in the tailnet and
// do not depend on the extender's ARP behaviour. All four negotiate DIRECT
// connections (verify with `tailscale status` — should read `direct`, not
// `relay`), so there is no relay hop in the path.
//
// `lan` is retained as documentation and a manual recovery path ONLY. Nothing
// in the app reads it. If you need it, re-probe before trusting it:
//   ssh -o ConnectTimeout=3 -o BatchMode=yes absolome@<lan-ip> hostname
// Spark NIC MACs are fc:9d:05:13:<suffix> matching the hostname
// (edgexpert-77fd → …:77:fd), so `ip neigh` on any node maps IP → node.

export type NodeKey = "spark1" | "spark2" | "spark3" | "spark4";

export interface NodeAddr {
  /** Tailscale IP. What the dashboard actually connects to. Stable. */
  ts: string;
  /** Tailscale MagicDNS name — identical to the node's hostname. */
  dns: string;
  /** LAN IP. DHCP, drifts, ARP-proxied by the extender. Reference only. */
  lan: string;
}

export const NODES: Record<NodeKey, NodeAddr> = {
  spark1: { ts: "100.79.103.61", dns: "edgexpert-74a6", lan: "10.0.0.223" },
  spark2: { ts: "100.112.35.83", dns: "edgexpert-77fd", lan: "10.0.0.45" },
  spark3: { ts: "100.71.243.12", dns: "edgexpert-88dd", lan: "10.0.0.101" },
  spark4: { ts: "100.123.85.111", dns: "edgexpert-7833", lan: "10.0.0.66" },
};

/**
 * Address to show in the UI for a node. Deliberately the same value the server
 * dials, so the dashboard cannot claim one address while using another — the
 * exact bug that made the old hardcoded `192.168.99.10-13` labels misleading
 * (that subnet has not existed since the 2026-07-21 fabric renumber to
 * 192.168.177.x / 192.168.178.x, yet the cards displayed it for months).
 */
export function displayAddr(key: NodeKey): string {
  return NODES[key].ts;
}
