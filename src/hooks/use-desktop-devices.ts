"use client";

import { useState, useEffect, useCallback } from "react";
import { deleteJson, fetchJson, postJson } from "@/lib/http";
import type { DeviceGroup } from "@/lib/devices/shared";

/** A computer running the desktop agent, as the settings page lists it. */
export interface DesktopDevice {
  id: string;
  name: string;
  platform: string;
  session: string;
  capabilities: DeviceGroup[];
  agentVersion: string;
  connected: boolean;
  lastSeenAt: string | null;
  createdAt: string;
}

/** An agent build to download, for this instance's version. */
export interface DesktopDownload {
  label: string;
  file: string;
  url: string;
}

/** A freshly minted pairing code. */
export interface DevicePairCode {
  code: string;
  expiresAt: string;
}

/**
 * Self-contained hook for the desktop agent's state and actions.
 *
 * The agent dials out to this instance, so there is nothing to reach: the page
 * lists what has paired, mints a code for a new one, and can disconnect a
 * computer. A paired computer's tools only reach chats started from it.
 */
export function useDesktopDevices() {
  const [devices, setDevices] = useState<DesktopDevice[]>([]);
  const [downloads, setDownloads] = useState<DesktopDownload[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [pairCode, setPairCode] = useState<DevicePairCode | null>(null);
  const [creatingCode, setCreatingCode] = useState(false);
  const [revokingId, setRevokingId] = useState<string | null>(null);

  const loadDevices = useCallback(async () => {
    try {
      const data = await fetchJson<{ devices: DesktopDevice[]; downloads: DesktopDownload[] }>(
        "/api/devices",
      );
      setDevices(data.devices);
      setDownloads(data.downloads);
      setError(null);
    } catch (err) {
      console.error("Failed to load the paired computers:", err);
      setError((err as Error).message || "Failed to load your computers");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void loadDevices();
  }, [loadDevices]);

  /** Mint a code. A previous one stops working, which is the point. */
  const createPairCode = useCallback(async () => {
    setCreatingCode(true);
    try {
      setPairCode(await postJson<DevicePairCode>("/api/devices/pair-code", {}));
    } catch (err) {
      console.error("Failed to create a pairing code:", err);
      setError((err as Error).message || "Could not create a pairing code");
    } finally {
      setCreatingCode(false);
    }
  }, []);

  const resetPairCode = useCallback(() => setPairCode(null), []);

  const revokeDevice = useCallback(async (deviceId: string) => {
    setRevokingId(deviceId);
    try {
      await deleteJson(`/api/devices/${deviceId}`);
      setDevices((prev) => prev.filter((device) => device.id !== deviceId));
    } catch (err) {
      console.error("Failed to disconnect a computer:", err);
      setError((err as Error).message || "Could not disconnect that computer");
    } finally {
      setRevokingId(null);
    }
  }, []);

  return {
    devices,
    downloads,
    loading,
    error,
    pairCode,
    creatingCode,
    revokingId,
    loadDevices,
    createPairCode,
    resetPairCode,
    revokeDevice,
  };
}
