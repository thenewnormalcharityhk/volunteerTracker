// Offline checks for the shadow-role work. No network, no secrets.
//   npx tsx test/roles.test.ts
import { parseAttendanceRole } from "../src/mapping.js";
import { aggregate } from "../src/rules.js";
import type { GroupRow, VolunteerRow } from "../src/notion.js";

let failures = 0;
function check(label: string, actual: unknown, expected: unknown) {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a === e) console.log(`  ok    ${label}`);
  else {
    failures++;
    console.log(`  FAIL  ${label}\n          expected ${e}\n          got      ${a}`);
  }
}

console.log("\nparseAttendanceRole — all four question wordings seen in TNN's Calendly");
// Wording 1 & 2 (2025-09 onwards): shadow host or co-host, no Host option.
const q1 = "Are you joining as shadow host or co-host?";
const q2 = "Are you joining as shadow host or co-host? "; // trailing space in Calendly
// Wording 3 (2026-03 onwards): shadow host or signed off host.
const q3 = "Are you joining as shadow host or signed off host?";
// Wording 4 (current): the three-way question.
const q4 = "Are you joining as host / co-host / shadow host?";

for (const [n, q] of [["v1", q1], ["v2", q2], ["v3", q3], ["v4", q4]] as const) {
  check(`${n} "Shadow Host"`, parseAttendanceRole([{ question: q, answer: "Shadow Host" }]), "shadow");
}
check(`v1 "Co-host"`, parseAttendanceRole([{ question: q1, answer: "Co-host" }]), "co-host");
check(`v3 "Signed Off Host" counts as hosting`, parseAttendanceRole([{ question: q3, answer: "Signed Off Host" }]), "host");
check(`v4 "Host"`, parseAttendanceRole([{ question: q4, answer: "Host" }]), "host");

console.log("\nparseAttendanceRole — things it must NOT read as a role");
check("no questions at all (pre-2025-09 bookings)", parseAttendanceRole([]), null);
check("undefined", parseAttendanceRole(undefined), null);
check(
  "free-text prep question mentioning shadow in the ANSWER",
  parseAttendanceRole([
    { question: "Please share anything that will help prepare for our meeting.", answer: "New host, will do shadow host this time" },
  ]),
  null,
);
check(
  "Host Connection Space question (hosting or attending)",
  parseAttendanceRole([{ question: "Are you hosting or attending?", answer: "Attendee" }]),
  null,
);
check("blank answer", parseAttendanceRole([{ question: q4, answer: "" }]), null);

console.log("\naggregate — hosted and shadowed sessions stay apart");
const vols: VolunteerRow[] = [
  { id: "katie", name: "Katie", email: null, status: "Shadow", dateOfApplication: null },
  { id: "ivan", name: "Ivan", email: null, status: "Active Host", dateOfApplication: null },
];
const g = (id: string, date: string, hostIds: string[], coHostIds: string[], shadowIds: string[]): GroupRow => ({
  id, name: "Good Grief", date, type: "Peer support group", status: "Confirmed", hostIds, coHostIds, shadowIds,
});
const groups: GroupRow[] = [
  g("g1", "2026-05-01T00:00:00Z", ["ivan"], [], ["katie"]),
  g("g2", "2026-06-01T00:00:00Z", ["ivan"], [], ["katie"]),
  g("g3", "2026-07-01T00:00:00Z", ["katie"], ["ivan"], []),
  // Canceled sessions never count.
  { ...g("g4", "2026-08-01T00:00:00Z", ["ivan"], [], ["katie"]), name: "[CANCELED] Good Grief" },
];
const agg = aggregate(vols, groups);
const katie = agg.get("katie")!;
const ivan = agg.get("ivan")!;
check("Katie shadowed 2", katie.shadowTotal, 2);
check("Katie hosted 1 (the session she actually hosted)", katie.hostedTotal, 1);
check("Katie last shadowed 2026-06-01", katie.shadowDates[0]?.toISOString().slice(0, 10), "2026-06-01");
check("Katie last active in any role 2026-07-01", katie.lastAny?.toISOString().slice(0, 10), "2026-07-01");
check("Ivan hosted 3", ivan.hostedTotal, 3);
check("Ivan shadowed 0", ivan.shadowTotal, 0);

console.log(failures === 0 ? "\nAll checks passed.\n" : `\n${failures} check(s) FAILED.\n`);
process.exit(failures === 0 ? 0 : 1);
