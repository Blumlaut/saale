"use client";

import { useState, useEffect, useCallback } from "react";
import { deleteJson, fetchJson, postJson } from "@/lib/http";
import { CLIENT_DEVICE_COOKIE, type DeviceGroup } from "@/lib/devices/shared";

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
  /** The last few things this machine was asked to do. */
  recent: {
    summary: string;
    outcome: "ok" | "error" | "blocked";
    tool: string;
    createdAt: string;
  }[];
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

/** The device this browser claims to be, from the cookie a chat is created with. */
function readBrowserDevice(): string | null {
  const match = document.cookie.match(new RegExp(`(?:^|; )${CLIENT_DEVICE_COOKIE}=([^;]*)`));
  return match?.[1] ? decodeURIComponent(match[1]) : null;
}

/** Claim a device for chats started in this browser, or drop the claim. */
function writeBrowserDevice(deviceId: string | null): void {
  const year = 60 * 60 * 24 * 365;
  document.cookie = deviceId
    ? `${CLIENT_DEVICE_COOKIE}=${encodeURIComponent(deviceId)}; path=/; max-age=${year}; samesite=lax`
    : `${CLIENT_DEVICE_COOKIE}=; path=/; max-age=0; samesite=lax`;
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
  const [browserDeviceId, setBrowserDeviceId] = useState<string | null>(null);

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
    setBrowserDeviceId(readBrowserDevice());
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

  /** Chats started in this browser use that computer from now on. */
  const useInBrowser = useCallback((deviceId: string | null) => {
    writeBrowserDevice(deviceId);
    setBrowserDeviceId(deviceId);
  }, []);

  return {
    devices,
    browserDeviceId,
    useInBrowser,
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
