import dns from "node:dns/promises";
import net from "node:net";
import tls from "node:tls";

/** Result of an autodiscover attempt for one protocol */
export interface ServerConfig {
  host: string;
  port: number;
  secure: boolean;
}

/** Full autodiscover result */
export interface AutodiscoverResult {
  imap: ServerConfig | null;
  smtp: ServerConfig | null;
  /** Whether the result came from SRV (most reliable) or heuristic probing */
  source: "srv" | "probe" | null;
}

/**
 * Per-connection timeout. A reachable mail server answers its banner in well
 * under a second; the only way to wait this long is a firewall dropping the
 * packets, so this doubles as "give up on this host".
 */
const PROBE_TIMEOUT = 2_500;

/**
 * Wall-clock budget for the whole lookup (SRV + probes + MX fallback).
 * Probes run in parallel, so a full miss costs about one probe timeout per
 * phase. this is the backstop that keeps a hostile/blackholed network from
 * hanging the "Detecting server settings…" spinner for minutes.
 */
const DISCOVERY_DEADLINE = 6_000;

/** How long to wait for a connection + banner before giving up (ms) */
const TCP_TIMEOUT = PROBE_TIMEOUT;

/** Candidate host patterns to probe, in priority order. */
function hostPatterns(domain: string): string[] {
  return [`imap.${domain}`, `smtp.${domain}`, `mail.${domain}`];
}

/**
 * Implicit-TLS ports. Everything else (143, 587, 25) starts plain and upgrades
 * with STARTTLS. marking those `secure: true` makes the client hang on a
 * handshake the server never speaks.
 */
function secureForPort(port: number): boolean {
  return port === 993 || port === 465;
}

/**
 * Connect to a socket, read the first data chunk as a banner, and clean it.
 * Returns the banner text or null on failure.
 */
async function readBanner(
  connect: (onData: (chunk: Buffer) => void) => net.Socket,
  timeoutMs: number,
): Promise<string | null> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      socket.destroy();
      resolve(null);
    }, timeoutMs);

    const socket = connect((chunk: Buffer) => {
      clearTimeout(timer);
      socket.destroy();
      resolve(chunk.toString("ascii").replace(/[\x00-\x08\x0e-\x1f\x7f-\xff]/g, ""));
    });

    socket.on("error", () => {
      clearTimeout(timer);
      resolve(null);
    });
  });
}

/**
 * Try a plain TCP connection and read a banner.
 * Returns the banner text or null on failure.
 */
async function readPlainBanner(
  host: string,
  port: number,
  timeoutMs = TCP_TIMEOUT,
): Promise<string | null> {
  return readBanner((onData) => {
    const socket = net.createConnection({ host, port, timeout: timeoutMs }, () => {});
    socket.on("data", onData);
    return socket;
  }, timeoutMs);
}

/**
 * Try a TLS connection and read the server banner through the encrypted channel.
 * Returns the banner text or null on failure.
 */
async function readTlsBanner(
  host: string,
  port: number,
  timeoutMs = TCP_TIMEOUT,
): Promise<string | null> {
  return readBanner((onData) => {
    const socket = tls.connect(
      {
        host,
        port,
        servername: host,
        rejectUnauthorized: false,
        timeout: timeoutMs,
      },
      () => {},
    );
    socket.on("data", onData);
    return socket;
  }, timeoutMs);
}

/** Check if a banner looks like an IMAP greeting (* OK or similar) */
export function isImapBanner(text: string): boolean {
  return /\* OK/i.test(text) || /\bIMAP\b/i.test(text);
}

/** Check if a banner looks like an SMTP greeting (220 ...) */
export function isSmtpBanner(text: string): boolean {
  return /^220\s/.test(text);
}

/**
 * Pick the highest-priority (lowest number) SRV record.
 * Returns null for an empty record set.
 */
export function pickBestSrv(
  records: Array<{ name: string; port: number; priority: number }>,
): { host: string; port: number } | null {
  if (records.length === 0) return null;
  const sorted = [...records].sort((a, b) => a.priority - b.priority);
  const best = sorted[0]!;
  return {
    host: best.name.endsWith(".") ? best.name.slice(0, -1) : best.name,
    port: best.port,
  };
}

/**
 * Look up the first service that publishes an SRV record, in preference order.
 * Returns null when none of them exist.
 */
async function lookupSrv(
  services: string[],
  domain: string,
): Promise<{ host: string; port: number } | null> {
  for (const service of services) {
    try {
      const best = pickBestSrv(await dns.resolveSrv(`${service}.${domain}`));
      if (best) return best;
    } catch (err) {
      // The common case by far: the domain publishes no SRV record at all.
      console.warn(
        `[autodiscover] ${service}.${domain}: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }
  return null;
}

/**
 * Extract the base domain from an MX exchange record.
 * e.g. "mx00.emig.gmx.net" -> "gmx.net"
 */
export function extractBaseDomain(mxExchange: string): string {
  const parts = mxExchange.replace(/\.$/, "").split(".");
  if (parts.length >= 2) {
    return parts.slice(-2).join(".");
  }
  return mxExchange;
}

/**
 * Try to probe a host for an IMAP server.
 * Checks SSL (993) and STARTTLS (143) concurrently, preferring implicit TLS.
 */
async function probeImap(host: string, timeoutMs: number): Promise<ServerConfig | null> {
  const [secure, plain] = await Promise.all([
    readTlsBanner(host, 993, timeoutMs),
    readPlainBanner(host, 143, timeoutMs),
  ]);

  if (secure && isImapBanner(secure)) return { host, port: 993, secure: true };
  if (plain && isImapBanner(plain)) return { host, port: 143, secure: false };
  return null;
}

/**
 * Try to probe a host for an SMTP server.
 * Checks SSL (465), STARTTLS (587) and plain (25) concurrently, preferring the
 * submission ports over port 25.
 */
async function probeSmtp(host: string, timeoutMs: number): Promise<ServerConfig | null> {
  const [ssl, starttls, plain] = await Promise.all([
    readTlsBanner(host, 465, timeoutMs),
    readPlainBanner(host, 587, timeoutMs),
    readPlainBanner(host, 25, timeoutMs),
  ]);

  if (ssl && isSmtpBanner(ssl)) return { host, port: 465, secure: true };
  if (starttls && isSmtpBanner(starttls)) return { host, port: 587, secure: false };
  if (plain && isSmtpBanner(plain)) return { host, port: 25, secure: false };
  return null;
}

/** Injectable seams. how the probe reaches the network. */
export interface DiscoveryDeps {
  lookupSrv(services: string[], domain: string): Promise<{ host: string; port: number } | null>;
  resolveMx(domain: string): Promise<Array<{ exchange: string; priority: number }>>;
  probeImap(host: string, timeoutMs: number): Promise<ServerConfig | null>;
  probeSmtp(host: string, timeoutMs: number): Promise<ServerConfig | null>;
}

const defaultDeps: DiscoveryDeps = { lookupSrv, resolveMx: dns.resolveMx, probeImap, probeSmtp };

export interface AutodiscoverOptions {
  /** Whole-lookup wall-clock budget in ms. */
  deadlineMs?: number;
  /** Per-connection timeout in ms. */
  probeTimeoutMs?: number;
  /** Override the network seams (tests). */
  deps?: Partial<DiscoveryDeps>;
}

/**
 * Resolve a probe with a time budget. The underlying promise is left to finish
 * (its sockets clean themselves up); we just stop waiting for it.
 */
function withDeadline<T>(promise: Promise<T>, budgetMs: number, fallback: T): Promise<T> {
  return new Promise<T>((resolve) => {
    if (budgetMs <= 0) {
      resolve(fallback);
      return;
    }
    const timer = setTimeout(() => resolve(fallback), budgetMs);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (err: unknown) => {
        clearTimeout(timer);
        console.error("[autodiscover] probe failed:", err);
        resolve(fallback);
      },
    );
  });
}

/**
 * Probe every host pattern concurrently and return the first hit in priority
 * order. `imap.<domain>` beats `mail.<domain>` regardless of which answered
 * first. A single failing host is logged and skipped; it must not sink the
 * protocol while another host pattern may still answer.
 */
async function probeHosts(
  hosts: string[],
  probe: (host: string, timeoutMs: number) => Promise<ServerConfig | null>,
  timeoutMs: number,
): Promise<ServerConfig | null> {
  const results = await Promise.all(
    hosts.map(async (host) => {
      try {
        return await probe(host, timeoutMs);
      } catch (err) {
        console.error(`[autodiscover] probe of ${host} failed:`, err);
        return null;
      }
    }),
  );
  return results.find((result): result is ServerConfig => result !== null) ?? null;
}

/**
 * Probe a protocol across the candidate hosts, bounded by the remaining budget.
 * The probes time out on their own, but enforcing the deadline here keeps
 * `autodiscover`'s promise. it never runs longer than `deadlineMs`
 * independent of how a probe behaves.
 */
function probePhase(
  hosts: string[],
  probe: (host: string, timeoutMs: number) => Promise<ServerConfig | null>,
  budgetMs: number,
): Promise<ServerConfig | null> {
  return withDeadline(probeHosts(hosts, probe, budgetMs), budgetMs, null);
}

/**
 * Autodiscover IMAP/SMTP settings for an email address.
 *
 * Strategy (zero hardcoded provider configs):
 * 1. DNS SRV records (_imaps/_imap, _submissions/_submission). RFC 6186 / RFC 8314
 * 2. TCP probe imap.<domain>, smtp.<domain>, mail.<domain> with banner verification
 * 3. MX fallback. extract base domain from MX records, probe those patterns
 *
 * Every phase runs its connections in parallel and is bounded by
 * `deadlineMs` overall, so a domain that blackholes traffic fails fast instead
 * of hanging the caller for minutes.
 */
export async function autodiscover(
  email: string,
  options: AutodiscoverOptions = {},
): Promise<AutodiscoverResult> {
  const atIdx = email.lastIndexOf("@");
  if (atIdx < 0) return { imap: null, smtp: null, source: null };

  const domain = email.slice(atIdx + 1).trim();
  if (!domain) return { imap: null, smtp: null, source: null };

  const deps: DiscoveryDeps = { ...defaultDeps, ...options.deps };
  const deadlineMs = options.deadlineMs ?? DISCOVERY_DEADLINE;
  const startedAt = Date.now();
  const remaining = () => deadlineMs - (Date.now() - startedAt);
  const probeTimeout = () =>
    Math.max(200, Math.min(options.probeTimeoutMs ?? PROBE_TIMEOUT, remaining()));

  // --- Step 1: SRV records (all lookups are fast DNS, run together) ---
  const [imapSrv, smtpSrv] = await Promise.all([
    withDeadline(deps.lookupSrv(["_imaps._tcp", "_imap._tcp"], domain), remaining(), null),
    withDeadline(
      deps.lookupSrv(["_submissions._tcp", "_submission._tcp"], domain),
      remaining(),
      null,
    ),
  ]);

  let imap: ServerConfig | null = imapSrv
    ? { ...imapSrv, secure: secureForPort(imapSrv.port) }
    : null;
  let smtp: ServerConfig | null = smtpSrv
    ? { ...smtpSrv, secure: secureForPort(smtpSrv.port) }
    : null;

  // --- Step 2: probe the host patterns (parallel; one phase, one timeout) ---
  if (!imap || !smtp) {
    const hosts = hostPatterns(domain);
    const probeTimeoutMs = probeTimeout();
    const [probedImap, probedSmtp] = await Promise.all([
      imap ?? probePhase(hosts, (host, t) => deps.probeImap(host, t), probeTimeoutMs),
      smtp ?? probePhase(hosts, (host, t) => deps.probeSmtp(host, t), probeTimeoutMs),
    ]);
    imap = probedImap;
    smtp = probedSmtp;
  }

  // --- Step 3: MX fallback for whatever is still missing ---
  if (!imap || !smtp) {
    const mxHosts = await withDeadline(mxHostPatterns(deps, domain), remaining(), []);
    if (mxHosts.length > 0) {
      const probeTimeoutMs = probeTimeout();
      const [mxImap, mxSmtp] = await Promise.all([
        imap ?? probePhase(mxHosts, (host, t) => deps.probeImap(host, t), probeTimeoutMs),
        smtp ?? probePhase(mxHosts, (host, t) => deps.probeSmtp(host, t), probeTimeoutMs),
      ]);
      imap = mxImap;
      smtp = mxSmtp;
    }
  }

  return {
    imap,
    smtp,
    source: imap || smtp ? (imapSrv || smtpSrv ? "srv" : "probe") : null,
  };
}

/** Host patterns derived from the domain's mail exchangers. */
async function mxHostPatterns(deps: DiscoveryDeps, domain: string): Promise<string[]> {
  try {
    const mxRecords = await deps.resolveMx(domain);
    if (mxRecords.length === 0) return [];
    const bestMx = [...mxRecords].sort((a, b) => a.priority - b.priority)[0]!;
    return hostPatterns(extractBaseDomain(bestMx.exchange));
  } catch (err) {
    console.warn(
      `[autodiscover] MX lookup failed for ${domain}: ${err instanceof Error ? err.message : String(err)}`,
    );
    return [];
  }
}
