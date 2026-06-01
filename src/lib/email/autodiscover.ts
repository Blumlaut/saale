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

/** How long to wait for a connection + banner before giving up (ms) */
const TCP_TIMEOUT = 8_000;

/**
 * Try a plain TCP connection and read a banner.
 * Returns the banner text or null on failure.
 */
async function readPlainBanner(host: string, port: number): Promise<string | null> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      socket.destroy();
      resolve(null);
    }, TCP_TIMEOUT);

    const socket = net.createConnection({ host, port, timeout: TCP_TIMEOUT }, () => {});

    socket.on("data", (chunk: Buffer) => {
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
 * Try a TLS connection and read the server banner through the encrypted channel.
 * Returns the banner text or null on failure.
 */
async function readTlsBanner(host: string, port: number): Promise<string | null> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      socket.destroy();
      resolve(null);
    }, TCP_TIMEOUT);

    const socket = tls.connect(
      {
        host,
        port,
        servername: host,
        rejectUnauthorized: false, // We just need to check if something speaks the protocol
        timeout: TCP_TIMEOUT,
      },
      () => {
        // TLS handshake complete — socket emits 'data' with the banner
      },
    );

    socket.on("data", (chunk: Buffer) => {
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

/** Check if a banner looks like an IMAP greeting (* OK or similar) */
function isImapBanner(text: string): boolean {
  return /\* OK/i.test(text) || /\bIMAP\b/i.test(text);
}

/** Check if a banner looks like an SMTP greeting (220 ...) */
function isSmtpBanner(text: string): boolean {
  return /^220\s/.test(text);
}

/**
 * Look up SRV records for a service.
 * Returns the highest-priority (lowest number) record, or null.
 */
async function lookupSrv(
  service: string,
  domain: string,
): Promise<{ host: string; port: number } | null> {
  try {
    const records = await dns.resolveSrv(`${service}.${domain}`);
    if (records.length === 0) return null;

    const sorted = [...records].sort((a, b) => a.priority - b.priority);
    const best = sorted[0]!;
    return {
      host: best.name.endsWith(".") ? best.name.slice(0, -1) : best.name,
      port: best.port,
    };
  } catch {
    return null;
  }
}

/**
 * Extract the base domain from an MX exchange record.
 * e.g. "mx00.emig.gmx.net" -> "gmx.net"
 */
function extractBaseDomain(mxExchange: string): string {
  const parts = mxExchange.replace(/\.$/, "").split(".");
  if (parts.length >= 2) {
    return parts.slice(-2).join(".");
  }
  return mxExchange;
}

/**
 * Try to probe a host for an IMAP server.
 * Checks SSL (993) first, then STARTTLS (143).
 */
async function probeImap(host: string): Promise<ServerConfig | null> {
  // Try SSL/TLS on 993
  const banner993 = await readTlsBanner(host, 993);
  if (banner993 && isImapBanner(banner993)) {
    return { host, port: 993, secure: true };
  }

  // Try STARTTLS on 143
  const banner143 = await readPlainBanner(host, 143);
  if (banner143 && isImapBanner(banner143)) {
    return { host, port: 143, secure: false };
  }

  return null;
}

/**
 * Try to probe a host for an SMTP server.
 * Checks SSL (465) first, then STARTTLS (587), then plain (25).
 */
async function probeSmtp(host: string): Promise<ServerConfig | null> {
  // Try SSL/TLS on 465
  const banner465 = await readTlsBanner(host, 465);
  if (banner465 && isSmtpBanner(banner465)) {
    return { host, port: 465, secure: true };
  }

  // Try STARTTLS on 587
  const banner587 = await readPlainBanner(host, 587);
  if (banner587 && isSmtpBanner(banner587)) {
    return { host, port: 587, secure: false };
  }

  // Try plain on 25
  const banner25 = await readPlainBanner(host, 25);
  if (banner25 && isSmtpBanner(banner25)) {
    return { host, port: 25, secure: false };
  }

  return null;
}

/**
 * Autodiscover IMAP/SMTP settings for an email address.
 *
 * Strategy (zero hardcoded configs):
 * 1. DNS SRV records (_imaps._tcp, _submission._tcp) — RFC 6186 / RFC 8314
 * 2. TCP probe imap.<domain>, smtp.<domain>, mail.<domain> with banner verification
 * 3. MX fallback — extract base domain from MX records, probe those patterns
 */
export async function autodiscover(email: string): Promise<AutodiscoverResult> {
  const atIdx = email.lastIndexOf("@");
  if (atIdx < 0) return { imap: null, smtp: null, source: null };

  const domain = email.slice(atIdx + 1);
  if (!domain) return { imap: null, smtp: null, source: null };

  // --- Step 1: SRV records ---
  const imapSrv = await lookupSrv("_imaps._tcp", domain);
  const smtpSrv = await lookupSrv("_submission._tcp", domain);

  if (imapSrv && smtpSrv) {
    return {
      imap: { ...imapSrv, secure: true },
      smtp: { ...smtpSrv, secure: true },
      source: "srv",
    };
  }

  // Partial SRV — use what we have, probe for the rest
  if (imapSrv || smtpSrv) {
    let imap: ServerConfig | null = imapSrv ? { ...imapSrv, secure: true } : null;
    let smtp: ServerConfig | null = smtpSrv ? { ...smtpSrv, secure: true } : null;

    const hosts = [`imap.${domain}`, `smtp.${domain}`, `mail.${domain}`];

    if (!imap) {
      for (const host of hosts) {
        imap = await probeImap(host);
        if (imap) break;
      }
    }
    if (!smtp) {
      for (const host of hosts) {
        smtp = await probeSmtp(host);
        if (smtp) break;
      }
    }

    return { imap, smtp, source: "srv" };
  }

  // --- Step 2: TCP probe common host patterns ---
  const hosts = [`imap.${domain}`, `smtp.${domain}`, `mail.${domain}`];
  let imap: ServerConfig | null = null;
  let smtp: ServerConfig | null = null;

  for (const host of hosts) {
    if (!imap) imap = await probeImap(host);
    if (!smtp) smtp = await probeSmtp(host);
    if (imap && smtp) break;
  }

  if (imap || smtp) {
    return { imap, smtp, source: "probe" };
  }

  // --- Step 3: MX fallback ---
  try {
    const mxRecords = await dns.resolveMx(domain);
    if (mxRecords.length > 0) {
      const bestMx = [...mxRecords].sort((a, b) => a.priority - b.priority)[0]!;
      const baseDomain = extractBaseDomain(bestMx.exchange);

      const mxHosts = [`imap.${baseDomain}`, `smtp.${baseDomain}`, `mail.${baseDomain}`];
      for (const host of mxHosts) {
        if (!imap) imap = await probeImap(host);
        if (!smtp) smtp = await probeSmtp(host);
        if (imap && smtp) break;
      }
    }
  } catch {
    // MX lookup failed
  }

  return { imap, smtp, source: imap || smtp ? "probe" : null };
}
