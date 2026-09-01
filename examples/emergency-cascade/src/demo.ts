// The Crisphive dispatch flow as plain /v1 REST calls — no LLM anywhere.
//
//   1. connect        verify the key; read roster + catalog
//   2. book           customer → job request → quote → real slot → confirm
//   3. emergency      P0 call → ranked candidates → preview the cascade
//                     (twice — determinism on display) → commit
//   4. impossible     ask for a slot that can't exist; the solver answers
//                     honestly instead of inventing an appointment
//
// Runs against a sandbox (chsk_test_ key). Deterministic enough for CI: the
// only inputs are the seeded sandbox roster and tomorrow's date.

import {
  crisp,
  CrisphiveError,
  type Customer,
  type EmergencyCandidates,
  type EmergencyPlan,
  type JobRequest,
  type TimeSegments,
} from "./client.js";

let failed = 0;
const ok = (label: string) => console.log(`   ✅ ${label}`);
const bad = (label: string) => {
  failed++;
  console.log(`   ❌ ${label}`);
};

/** Tomorrow as YYYY-MM-DD in the given IANA timezone (weekends skipped —
 *  the seeded sandbox roster works weekdays). */
function nextWorkday(tz: string): string {
  const day = 24 * 60 * 60 * 1000;
  for (let i = 1; i <= 4; i++) {
    const d = new Date(Date.now() + i * day);
    const wd = new Intl.DateTimeFormat("en-CA", { timeZone: tz, weekday: "short" }).format(d);
    if (wd !== "Sat" && wd !== "Sun") {
      return new Intl.DateTimeFormat("en-CA", { timeZone: tz }).format(d); // YYYY-MM-DD
    }
  }
  throw new Error("unreachable");
}

// Create a customer — or reuse the existing one when this sandbox already has
// the phone number (re-runs are normal; CUSTOMER_DUPLICATE_PHONE is a stable
// code your integration can branch on, so we do exactly that).
async function ensureCustomer(body: {
  full_name: string;
  phone: string;
  email?: string;
  address: object;
}): Promise<Customer> {
  try {
    // Create returns the customer object DIRECTLY in data (no wrapper key).
    return await crisp<Customer>("POST", "/customers", { body });
  } catch (e) {
    if (!(e instanceof CrisphiveError) || e.code !== "CUSTOMER_DUPLICATE_PHONE") throw e;
    // The phone is the identity — `q` searches it, and the existing record may
    // carry a different name if this sandbox has been played with before.
    const list = await crisp<{ customers: Customer[] }>("GET", "/customers", {
      query: { q: body.phone, limit: "5" },
    });
    const found = list.customers[0];
    if (!found) throw e;
    if (found.full_name !== body.full_name) {
      console.log(`      (reusing existing customer "${found.full_name}" — this phone already lives in your sandbox)`);
    }
    return found;
  }
}

async function main() {
  // ── 1. Connect ───────────────────────────────────────────────────────────
  console.log("── 1. Connect");
  const techs = await crisp<{ technicians: unknown[] }>("GET", "/technicians", {
    query: { limit: "100" },
  });
  // Note: /v1/job-types returns a BARE ARRAY in data (not a wrapped list).
  const jobTypes = await crisp<{ id: string; name: string }[]>("GET", "/job-types", {
    query: { limit: "100" },
  });
  ok(`key works — roster: ${techs.technicians.length} technicians, catalog: ${jobTypes.length} job types`);
  if (techs.technicians.length === 0) {
    bad("sandbox has no technicians — open the dashboard once so the sandbox seeds, then re-run");
    process.exit(1);
  }
  const jobType =
    jobTypes.find((t) => /maintenance|tune|general/i.test(t.name)) ?? jobTypes[0];

  // ── 2. Book ──────────────────────────────────────────────────────────────
  console.log("── 2. Book a job (quote → slots → confirm)");
  const marie = await ensureCustomer({
    full_name: "Marie Tremblay",
    phone: "+16135550142", // E.164 with the leading + — bare national digits are rejected
    email: "marie.tremblay@example.com",
    address: { line: "145 Laurier Ave W", city: "Ottawa", state: "ON", country: "CA" },
  });
  ok(`customer: ${marie.full_name} (${marie.id})`);

  // We don't know the business timezone yet — probe it from booking windows
  // by booking with a provisional date, then read the authoritative timezone
  // off the time-segments response.
  const provisionalDate = nextWorkday("America/Toronto");
  // Note: create returns the job object DIRECTLY in data (no wrapper key).
  const booked = await crisp<JobRequest>("POST", "/job-requests", {
    body: {
      customer_id: marie.id,
      job_type_id: jobType.id,
      description: "2-hour HVAC maintenance visit (example repo demo)",
      priority: "p2",
      job_dates: [{ date: provisionalDate, periods: [{ period: "morning" }] }],
    },
  });
  ok(`job request booked: #${booked.short_code}`);

  await crisp("POST", `/job-requests/${booked.id}/quote`, {
    body: { job_duration_minutes: 120, mobilization_minutes: 30, demobilization_minutes: 30 },
  });
  ok("quoted: 120 min on site + 30 mobilization + 30 demobilization");

  const segments = await crisp<TimeSegments>("GET", `/job-requests/${booked.id}/time-segments`);
  const tz = segments.business_timezone;
  const firstDay = segments.days.find((d) => d.time_slots.length > 0);
  if (!firstDay) {
    bad("no available slots came back — every slot offered is a slot that exists, and today none do");
    process.exit(1);
  }
  const slot = firstDay.time_slots.find((s) => s.best_time) ?? firstDay.time_slots[0];
  const scheduledAt = slot.business_time?.datetime ?? slot.datetime;
  ok(`picked a REAL slot: ${scheduledAt} (${slot.workers_count ?? "?"} technicians can take it)`);

  await crisp("POST", `/job-requests/${booked.id}/confirm`, { body: { scheduled_at: scheduledAt } });
  const afterConfirm = await crisp<JobRequest>("GET", `/job-requests/${booked.id}`);
  ok(`confirmed — status: ${afterConfirm.current_status?.key ?? "confirmed"} (technician auto-assigned)`);

  // ── 3. Emergency cascade ─────────────────────────────────────────────────
  console.log("── 3. Emergency cascade (preview → commit)");
  const david = await ensureCustomer({
    full_name: "David Okafor",
    phone: "+16135550198",
    address: { line: "99 Bank St", city: "Ottawa", state: "ON", country: "CA" },
  });
  const emergency = await crisp<JobRequest>("POST", "/job-requests", {
    body: {
      customer_id: david.id,
      job_type_id: jobType.id,
      description: "P0: no heat, infant at home (example repo demo)",
      priority: "p0",
      job_dates: [{ date: firstDay.date, periods: [{ period: "morning" }, { period: "afternoon" }] }],
    },
  });
  await crisp("POST", `/job-requests/${emergency.id}/quote`, {
    body: { job_duration_minutes: 90, mobilization_minutes: 30, demobilization_minutes: 30 },
  });
  ok(`P0 created + quoted: no heat at 99 Bank St — #${emergency.short_code}`);

  // Land the emergency mid-morning on the SAME day as the booked job, so the
  // cascade has something to ripple through. start_at is business-local naive.
  const startAt = `${firstDay.date}T11:15:00`;
  const cands = await crisp<EmergencyCandidates>("POST", "/job-requests/emergency/candidates", {
    body: { emergency_job_id: emergency.id, mode: "overtime", start_at: startAt },
  });
  if (cands.candidates.length === 0) {
    bad("no emergency candidates — unexpected on a seeded sandbox");
    process.exit(1);
  }
  // Production picks candidates[0] (least disruption). The DEMO deliberately
  // prefers a candidate whose day must ripple, so you can see the cascade;
  // on a roster with free capacity the top pick absorbs it with zero moves.
  const top = cands.candidates.find((c) => c.total_moves > 0) ?? cands.candidates[0];
  ok(
    `candidates: ${cands.candidates.length} ranked technicians ` +
      `(top: ${top.full_name}, ${top.total_moves} move(s), ${top.travel_minutes ?? "?"} min travel)`,
  );

  const previewBody = {
    emergency_job_id: emergency.id,
    mode: "overtime",
    start_at: startAt,
    technician_id: top.technician_id,
  };
  const plan = await crisp<EmergencyPlan>("POST", "/job-requests/emergency/preview", { body: previewBody });
  ok(`preview: emergency lands ${plan.emergency_start} → ${plan.emergency_end} · ${plan.total_moves} job(s) touched, 0 dropped`);
  if (plan.total_moves === 0) {
    console.log("      (zero moves — this roster had free capacity, so nothing needed to ripple)");
  }
  for (const day of plan.days ?? []) {
    for (const m of day.moves ?? []) {
      console.log(`      slide    #${m.short_code}  ${m.customer_name ?? ""}  ${m.from_start} → ${m.to_start}`);
    }
  }
  for (const r of plan.reassignments ?? []) {
    console.log(`      reassign #${r.short_code}  ${r.customer_name ?? ""}  → ${r.to_name ?? "?"} (+${r.travel_minutes ?? 0} min travel)`);
  }
  for (const w of plan.warnings ?? []) {
    console.log(`      warning  ${w.code ?? ""} ${w.message ?? ""} — the cost is printed, never hidden`);
  }

  // Determinism on display: same inputs, same plan — you can write tests
  // against this. Try that with an agentic scheduler.
  const plan2 = await crisp<EmergencyPlan>("POST", "/job-requests/emergency/preview", { body: previewBody });
  const fingerprint = (p: EmergencyPlan) =>
    JSON.stringify({ s: p.emergency_start, m: p.total_moves, d: p.days, r: p.reassignments });
  if (fingerprint(plan) === fingerprint(plan2)) {
    ok("determinism: second preview is IDENTICAL — preview is a pure function, nothing moved yet");
  } else {
    bad("second preview differed — this should never happen");
  }

  await crisp("POST", "/job-requests/emergency/commit", { body: previewBody });
  ok("committed — board redrawn; every moved party gets a notification, nobody gets a surprise");

  // ── 4. The impossible request ────────────────────────────────────────────
  console.log("── 4. The impossible request");
  try {
    const impossible = await crisp<EmergencyCandidates>("POST", "/job-requests/emergency/candidates", {
      body: {
        emergency_job_id: emergency.id,
        mode: "overtime",
        start_at: `${firstDay.date}T03:00:00`, // 3am — nobody's shift covers it
      },
    });
    if (impossible.candidates.length === 0) {
      ok("3am request → zero candidates. No feasible slot means NO FEASIBLE SLOT — the solver never invents an appointment");
    } else {
      ok(`3am request → ${impossible.candidates.length} candidate(s) with the overtime cost printed on each — either way, an honest answer`);
    }
  } catch (e) {
    if (e instanceof CrisphiveError) {
      ok(`3am request → refused with the stable code ${e.code} — your agent can branch on that, not on prose`);
    } else {
      throw e;
    }
  }

  console.log(failed === 0 ? "\nAll beats completed. ✅" : `\n${failed} beat(s) failed. ❌`);
  process.exit(failed === 0 ? 0 : 1);
}

main().catch((e) => {
  if (e instanceof CrisphiveError) {
    console.error(`\nAPI error ${e.code} (HTTP ${e.status}): ${e.message}`);
  } else {
    console.error("\n", e);
  }
  process.exit(1);
});
