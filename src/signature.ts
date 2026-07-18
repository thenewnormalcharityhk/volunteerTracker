// Calendly webhook signature verification.
//
// Calendly sends every webhook with a `Calendly-Webhook-Signature` header of the form:
//   t=1700000000,v1=<hex_hmac_sha256>
// where the HMAC is computed as: HMAC_SHA256(signing_key, `${t}.${raw_body}`).
//
// Docs: https://developer.calendly.com/api-docs/ZG9jOjE2OTQ2MjQ-webhook-signatures

export interface VerifyResult {
  ok: boolean;
  reason?: string;
}

export async function verifyCalendlySignature(opts: {
  rawBody: string;
  header: string | null;
  signingKey: string;
  toleranceSeconds?: number;
}): Promise<VerifyResult> {
  const tolerance = opts.toleranceSeconds ?? 300; // 5 minutes
  if (!opts.header) return { ok: false, reason: "missing signature header" };

  // Parse `t=...,v1=...`
  const parts = Object.fromEntries(
    opts.header.split(",").map((kv) => {
      const idx = kv.indexOf("=");
      return [kv.slice(0, idx).trim(), kv.slice(idx + 1).trim()];
    }),
  ) as { t?: string; v1?: string };

  if (!parts.t || !parts.v1) return { ok: false, reason: "malformed signature header" };

  const ts = parseInt(parts.t, 10);
  if (!Number.isFinite(ts)) return { ok: false, reason: "bad timestamp" };

  const ageSec = Math.abs(Date.now() / 1000 - ts);
  if (ageSec > tolerance) return { ok: false, reason: `stale timestamp (${ageSec.toFixed(0)}s old)` };

  const expected = await hmacSha256Hex(opts.signingKey, `${parts.t}.${opts.rawBody}`);
  if (!constantTimeEqual(expected, parts.v1)) {
    return { ok: false, reason: "signature mismatch" };
  }
  return { ok: true };
}

async function hmacSha256Hex(key: string, message: string): Promise<string> {
  const enc = new TextEncoder();
  const cryptoKey = await crypto.subtle.importKey(
    "raw",
    enc.encode(key),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const sig = await crypto.subtle.sign("HMAC", cryptoKey, enc.encode(message));
  return [...new Uint8Array(sig)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

function constantTimeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let result = 0;
  for (let i = 0; i < a.length; i++) {
    result |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return result === 0;
}
