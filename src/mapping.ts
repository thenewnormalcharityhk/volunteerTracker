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
