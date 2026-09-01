// Tiny typed client for the Crisphive Developer API (/v1).
//
// Every response is the same envelope: { error_code, message, data }.
// error_code is 0 on success and a STABLE STRING on failure — match codes,
// never message text (messages are localized and may be reworded).

const BASE = (process.env.CRISPHIVE_API_URL ?? "https://api.crisphive.com").replace(/\/$/, "");
const KEY = process.env.CRISPHIVE_API_KEY ?? "";

export class CrisphiveError extends Error {
  constructor(
    public readonly code: string,
    message: string,
    public readonly status: number,
  ) {
    super(`${code}: ${message}`);
  }
}

export async function crisp<T>(
  method: string,
  path: string,
  opts: { body?: unknown; query?: Record<string, string> } = {},
): Promise<T> {
  // SANDBOX ONLY, deliberately: this demo books jobs and commits an emergency
  // reschedule. On a chsk_live_ key those would be real mutations on a real
  // business's schedule. If you truly want that, edit this line — that edit
  // is the consent.
  if (!KEY.startsWith("chsk_test_")) {
    throw new Error(
      "Set CRISPHIVE_API_KEY to a chsk_test_ SANDBOX key (see .env.example) — the demo mutates data, so live keys are refused.",
    );
  }
  const url = new URL(`${BASE}/v1${path}`);
  for (const [k, v] of Object.entries(opts.query ?? {})) url.searchParams.set(k, v);

  const res = await fetch(url, {
    method,
    headers: {
      authorization: `Bearer ${KEY}`,
      "content-type": "application/json",
    },
    body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
  });
  // A gateway/LB error page is not JSON — say "HTTP 502", not SyntaxError.
  const raw = await res.text();
  let envelope: { error_code: number | string; message: string; data: T };
  try {
    envelope = JSON.parse(raw);
  } catch {
    throw new CrisphiveError("NON_JSON_RESPONSE", `HTTP ${res.status} — body was not JSON (gateway error?)`, res.status);
  }
  if (envelope.error_code !== 0) {
    throw new CrisphiveError(String(envelope.error_code), envelope.message, res.status);
  }
  return envelope.data;
}

// ── The handful of response shapes the demo reads (subset of the OpenAPI
//    models at https://api.crisphive.com/developers/openapi.json) ──────────

export interface Customer {
  id: string;
  full_name: string;
}

export interface JobRequest {
  id: string;
  short_code: string;
  status_version?: number;
  current_status?: { key?: string };
}

export interface TimeSegmentsSlot {
  datetime: string;
  best_time?: boolean;
  workers_count?: number;
  business_time?: { datetime: string; date: string; time: string };
}

export interface TimeSegments {
  business_timezone: string;
  days: { date: string; time_slots: TimeSegmentsSlot[] }[];
}

export interface EmergencyCandidate {
  technician_id: string;
  full_name: string;
  total_moves: number;
  travel_minutes?: number;
  distance_km?: number;
}

export interface EmergencyCandidates {
  business_timezone: string;
  candidates: EmergencyCandidate[];
}

export interface EmergencyPlan {
  emergency_start: string;
  emergency_end: string;
  technician_id: string;
  total_moves: number;
  days: {
    date: string;
    moves: {
      short_code: string;
      customer_name?: string;
      from_start: string;
      to_start: string;
    }[];
  }[];
  reassignments: {
    short_code: string;
    customer_name?: string;
    to_name?: string;
    travel_minutes?: number;
  }[];
  warnings: { code?: string; message?: string; job_id?: string }[];
}
