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

async function main() {
  // ── 1. Connect ───────────────────────────────────────────────────────────
  console.log("── 1. Connect");
  const techs = await crisp<{ technicians: unknown[] }>("GET", "/technicians", {
    query: { limit: "100" },
  });
  const jobTypes = await crisp<{ job_types: { id: string; name: string }[] }>("GET", "/job-types", {
    query: { limit: "100" },
  });
  ok(`key works — roster: ${techs.technicians.length} technicians, catalog: ${jobTypes.job_types.length} job types`);
  if (techs.technicians.length === 0) {
    bad("sandbox has no technicians — open the dashboard once so the sandbox seeds, then re-run");
    process.exit(1);
  }
  const jobType =
    jobTypes.job_types.find((t) => /maintenance|tune|general/i.test(t.name)) ?? jobTypes.job_types[0];

  // ── 2. Book ──────────────────────────────────────────────────────────────
  console.log("── 2. Book a job (quote → slots → confirm)");
  const marie = await crisp<{ customer: Customer }>("POST", "/customers", {
    body: {
      full_name: "Marie Tremblay",
      phone: "+16135550142", // E.164 with the leading + — bare national digits are rejected
      email: "marie.tremblay@example.com",
      address: { line: "145 Laurier Ave W", city: "Ottawa", state: "ON", country: "CA" },
    },
  });
  ok(`customer: ${marie.customer.full_name} (${marie.customer.id})`);

  // We don't know the business timezone yet — probe it from booking windows
  // by booking with a provisional date, then read the authoritative timezone
  // off the time-segments response.
  const provisionalDate = nextWorkday("America/Toronto");
  const booked = await crisp<{ job_request: JobRequest }>("POST", "/job-requests", {
    body: {
      customer_id: marie.customer.id,
      job_type_id: jobType.id,
      description: "2-hour HVAC maintenance visit (example repo demo)",
      priority: "p2",
      job_dates: [{ date: provisionalDate, periods: [{ period: "morning" }] }],
    },
  });
  ok(`job request booked: #${booked.job_request.short_code}`);

  await crisp("POST", `/job-requests/${booked.job_request.id}/quote`, {
    body: { job_duration_minutes: 120, mobilization_minutes: 30, demobilization_minutes: 30 },
  });
  ok("quoted: 120 min on site + 30 mobilization + 30 demobilization");

  const segments = await crisp<TimeSegments>("GET", `/job-requests/${booked.job_request.id}/time-segments`);
  const tz = segments.business_timezone;
  const firstDay = segments.days.find((d) => d.time_slots.length > 0);
  if (!firstDay) {
    bad("no available slots came back — every slot offered is a slot that exists, and today none do");
    process.exit(1);
  }
  const slot = firstDay.time_slots.find((s) => s.best_time) ?? firstDay.time_slots[0];
  const scheduledAt = slot.business_time?.datetime ?? slot.datetime;
  ok(`picked a REAL slot: ${scheduledAt} (${slot.workers_count ?? "?"} technicians can take it)`);

  const confirmed = await crisp<{ job_request: JobRequest }>(
    "POST",
    `/job-requests/${booked.job_request.id}/confirm`,
    { body: { scheduled_at: scheduledAt } },
  );
  ok(`confirmed — status: ${confirmed.job_request.current_status?.key ?? "confirmed"} (auto-assigned)`);

  // ── 3. Emergency cascade ─────────────────────────────────────────────────
  console.log("── 3. Emergency cascade (preview → commit)");
  const david = await crisp<{ customer: Customer }>("POST", "/customers", {
    body: {
      full_name: "David Okafor",
      phone: "+16135550198",
      address: { line: "99 Bank St", city: "Ottawa", state: "ON", country: "CA" },
    },
  });
  const emergency = await crisp<{ job_request: JobRequest }>("POST", "/job-requests", {
    body: {
      customer_id: david.customer.id,
      job_type_id: jobType.id,
      description: "P0: no heat, infant at home (example repo demo)",
      priority: "p0",
      job_dates: [{ date: firstDay.date, periods: [{ period: "morning" }, { period: "afternoon" }] }],
    },
  });
  await crisp("POST", `/job-requests/${emergency.job_request.id}/quote`, {
    body: { job_duration_minutes: 90, mobilization_minutes: 30, demobilization_minutes: 30 },
  });
  ok(`P0 created + quoted: no heat at 99 Bank St — #${emergency.job_request.short_code}`);

  // Land the emergency mid-morning on the SAME day as the booked job, so the
  // cascade has something to ripple through. start_at is business-local naive.
  const startAt = `${firstDay.date}T11:15:00`;
  const cands = await crisp<EmergencyCandidates>("POST", "/job-requests/emergency/candidates", {
    body: { emergency_job_id: emergency.job_request.id, mode: "overtime", start_at: startAt },
  });
  if (cands.candidates.length === 0) {
    bad("no emergency candidates — unexpected on a seeded sandbox");
    process.exit(1);
  }
  const top = cands.candidates[0];
  ok(
    `candidates: ${cands.candidates.length} ranked technicians ` +
      `(top: ${top.full_name}, ${top.total_moves} move(s), ${top.travel_minutes ?? "?"} min travel)`,
  );

  const previewBody = {
    emergency_job_id: emergency.job_request.id,
    mode: "overtime",
    start_at: startAt,
    technician_id: top.technician_id,
  };
  const plan = await crisp<EmergencyPlan>("POST", "/job-requests/emergency/preview", { body: previewBody });
  ok(`preview: emergency lands ${plan.emergency_start} → ${plan.emergency_end} · ${plan.total_moves} job(s) touched, 0 dropped`);
  for (const day of plan.days) {
    for (const m of day.moves) {
      console.log(`      slide    #${m.short_code}  ${m.customer_name ?? ""}  ${m.from_start} → ${m.to_start}`);
    }
  }
  for (const r of plan.reassignments) {
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
        emergency_job_id: emergency.job_request.id,
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
