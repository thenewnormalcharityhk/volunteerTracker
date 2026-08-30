// Routes a Calendly event-type name to the right Notion destination.
//
// Three outcomes:
//   - { kind: "group" }                     → Groups DB, one row, Host + Co-host relations
//   - { kind: "training", trainingType }    → Training Log DB, one row PER attendee
//   - { kind: "skip" }                      → nothing written (e.g. recruitment interviews)
//
// Matching is a case-insensitive substring check on the Calendly event-type
// name; rules are evaluated top-to-bottom, first match wins. Anything that
// doesn't match a skip or training rule is treated as a peer-support group.
//
// Tuned against the 22 live TNN event types (April 2026). Edit as types change.

export type GroupType = "Peer support group" | "Q&A with Clinical Advisor" | "Training";

// Training Log "Training Type" select options (extended for Calendly sync).
export type TrainingType =
  | "SFA"
  | "Gender inclusion"
  | "Trauma-informed"
  | "Refresher"
  | "Clinical Q&A"
  | "Development session"
  | "Host connection"
  | "Shadow session"
  | "Other";

export type Routing =
  | { kind: "group"; groupType: GroupType }
  | { kind: "training"; trainingType: TrainingType }
  | { kind: "skip"; reason: string };

interface Rule {
  match: string; // case-insensitive substring of the Calendly event-type name
  route: Routing;
}

// First match wins. Order matters — more specific terms first.
const RULES: Rule[] = [
  // ── Skipped (not groups, not training) ──
  { match: "interview", route: { kind: "skip", reason: "recruitment interview" } },

  // ── Training Log (one row per attendee) ──
  // 1:1 supervision / sign-off conversations with the clinical advisors.
  { match: "development session", route: { kind: "training", trainingType: "Development session" } },
  // Host community spaces.
  { match: "host connection", route: { kind: "training", trainingType: "Host connection" } },
  // Group sessions with the clinical advisor (English / Cantonese).
  { match: "clinical advisor", route: { kind: "training", trainingType: "Clinical Q&A" } },
  { match: "q&a", route: { kind: "training", trainingType: "Clinical Q&A" } },
  // Refreshers and named trainings.
  { match: "refresher", route: { kind: "training", trainingType: "Refresher" } },
  { match: "sfa", route: { kind: "training", trainingType: "SFA" } },
  { match: "suicide first aid", route: { kind: "training", trainingType: "SFA" } },
  { match: "gender inclusion", route: { kind: "training", trainingType: "Gender inclusion" } },
  { match: "trauma-informed", route: { kind: "training", trainingType: "Trauma-informed" } },
  { match: "trauma informed", route: { kind: "training", trainingType: "Trauma-informed" } },
  { match: "training", route: { kind: "training", trainingType: "Other" } },
];

// Default for anything unmatched: a peer-support group.
const DEFAULT_ROUTE: Routing = { kind: "group", groupType: "Peer support group" };

export function classifyEvent(eventTypeName: string): Routing {
  const lower = eventTypeName.toLowerCase();
  for (const rule of RULES) {
    if (lower.includes(rule.match)) return rule.route;
  }
  return DEFAULT_ROUTE;
}

// ── Attendance role (host / co-host / shadow) ──
//
// The peer-support group event types carry a required Calendly booking
// question:
//
//   "Are you joining as host / co-host / shadow host?"
//     → "Host" | "Co-host" | "Shadow Host"
//
// It arrives on the invitee as `questions_and_answers`. This is the real
// source of shadow-session data; before it was read, shadows were written
// into Co-host and their sessions were only approximated.
//
// Only call this for events classified as `kind: "group"`. Training events
// carry different questions that would misread here — Host Connection Space
// asks "Are you hosting or attending?" and Welcome Back Refresher asks
// whether you are a "Signed Off Host" or "Shadow Host", which describes the
// volunteer's status rather than a session they shadowed.
//
// Returns null when the event type has no role question, or the answer is
// unrecognised. Callers fall back to the old first-booker-is-host rule.

export type AttendanceRole = "host" | "co-host" | "shadow";

export function parseAttendanceRole(
  questionsAndAnswers?: Array<{ question: string; answer: string }>,
): AttendanceRole | null {
  if (!questionsAndAnswers?.length) return null;
  for (const qa of questionsAndAnswers) {
    const question = (qa.question ?? "").toLowerCase();
    // Only the role question mentions all three; guards against future
    // free-text questions that happen to contain the word "host".
    if (!question.includes("shadow")) continue;
    const answer = (qa.answer ?? "").trim().toLowerCase();
    if (!answer) continue;
    // Order matters: "Shadow Host" and "Co-host" both contain "host".
    if (answer.includes("shadow")) return "shadow";
    if (answer.includes("co-host") || answer.includes("co host")) return "co-host";
    if (answer.includes("host")) return "host";
  }
  return null;
}

// Infer the tutor / clinical advisor from the event name.
//   - "Development sessions with Chris" → "Chris"
//   - "Cantonese - Group Session with Clinical Advisor" → "Cindy" (Cantonese advisor)
//   - "English - Group Session with Clinical Advisor"  → "Chris" (English advisor)
// Returns null when undetectable.
export function inferTutor(eventTypeName: string): string | null {
  const m = /with\s+([A-Z][a-z]+)/.exec(eventTypeName);
  if (m && m[1]) return m[1];
  const lower = eventTypeName.toLowerCase();
  if (lower.includes("clinical advisor")) {
    if (lower.includes("canto")) return "Cindy";
    if (lower.includes("english")) return "Chris";
  }
  return null;
}

// Infer language from the event name. Calendly has no language field, so we
// look for explicit markers and the presence of Chinese characters.
// Returns null if undetectable — coordinator fills in during Pending review.
export type Language = "English" | "Cantonese" | "Both";

export function inferLanguage(eventTypeName: string): Language | null {
  const lower = eventTypeName.toLowerCase();
  const hasChineseChars = /[一-鿿]/.test(eventTypeName);
  const hasCanto = lower.includes("canto") || hasChineseChars;
  const hasEng = lower.includes("english") || lower.includes("(en)");
  if (hasCanto && hasEng) return "Both";
  if (hasCanto) return "Cantonese";
  if (hasEng) return "English";
  return null;
}
