import policyBook from "../../data/policies/support-policies.json" with { type: "json" };
import type { TicketIntent, TicketPriority, TicketRecord } from "./types";

export type PolicyCitation = {
  id: string;
  title: string;
  source: string;
  updatedAt: string;
  citation: string;
  score: number;
  matchedTerms: string[];
};

export type PolicyGrounding = {
  version: string;
  routeReason: string;
  citations: PolicyCitation[];
  context: string;
};

type PolicyRecord = {
  id: string;
  title: string;
  source: string;
  updatedAt: string;
  summary: string;
  guidance: string[];
  escalation: string[];
  intents: TicketIntent[];
  priorities: TicketPriority[];
  keywords: string[];
  tags: string[];
  citation: string;
  alwaysInclude?: boolean;
};

type PolicyBook = {
  version: string;
  policies: PolicyRecord[];
};

type ScoredPolicy = {
  policy: PolicyRecord;
  score: number;
  matchedTerms: string[];
};

const typedPolicyBook = policyBook as PolicyBook;

function normalizeText(value: unknown) {
  return String(value ?? "")
    .toLowerCase()
    .replaceAll("_", " ");
}

function escapeRegExp(value: string) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function includesPolicyTerm(searchText: string, term: string) {
  const normalized = normalizeText(term).trim();
  if (!normalized) return false;

  if (/^[a-z0-9]+$/.test(normalized)) {
    return new RegExp(`(^|[^a-z0-9])${escapeRegExp(normalized)}([^a-z0-9]|$)`).test(searchText);
  }

  return searchText.includes(normalized);
}

function ticketSearchText(ticket: TicketRecord) {
  const hasClassificationSignal =
    ticket.source !== "manual" &&
    (ticket.status !== "new" ||
      ticket.intent !== "general_support" ||
      ticket.priority !== "normal" ||
      ticket.sentiment !== "neutral");

  return [
    ticket.subject,
    ticket.body,
    ticket.source,
    ...(hasClassificationSignal ? [ticket.intent, ticket.priority, ticket.sentiment] : []),
    JSON.stringify(ticket.metadata ?? {}),
  ]
    .map(normalizeText)
    .join("\n");
}

function scorePolicy(ticket: TicketRecord, policy: PolicyRecord, searchText: string): ScoredPolicy {
  const matchedTerms = new Set<string>();
  let score = policy.alwaysInclude ? 2 : 0;
  const hasClassificationSignal =
    ticket.source !== "manual" &&
    (ticket.status !== "new" ||
      ticket.intent !== "general_support" ||
      ticket.priority !== "normal" ||
      ticket.sentiment !== "neutral");

  const intentMatches = hasClassificationSignal && policy.intents.includes(ticket.intent);

  if (intentMatches) {
    score += 6;
    matchedTerms.add(`intent:${ticket.intent}`);
  }

  if (intentMatches && policy.priorities.includes(ticket.priority)) {
    score += ticket.priority === "urgent" || ticket.priority === "high" ? 2 : 1;
    matchedTerms.add(`priority:${ticket.priority}`);
  }

  for (const keyword of policy.keywords) {
    if (includesPolicyTerm(searchText, keyword)) {
      score += 3;
      matchedTerms.add(keyword);
    }
  }

  for (const tag of policy.tags) {
    if (includesPolicyTerm(searchText, tag)) {
      score += 1;
      matchedTerms.add(`tag:${tag}`);
    }
  }

  return {
    policy,
    score,
    matchedTerms: [...matchedTerms],
  };
}

function toContext(scoredPolicies: ScoredPolicy[]) {
  return scoredPolicies
    .map(({ policy }) =>
      [
        `[${policy.id}] ${policy.title}`,
        `Source: ${policy.source}`,
        `Summary: ${policy.summary}`,
        `Approved guidance: ${policy.guidance.join(" ")}`,
        policy.escalation.length > 0 ? `Escalation: ${policy.escalation.join(" ")}` : "",
        `Citation: ${policy.citation}`,
      ]
        .filter(Boolean)
        .join("\n"),
    )
    .join("\n\n");
}

export function retrievePolicyGrounding(ticket: TicketRecord, limit = 3): PolicyGrounding {
  const searchText = ticketSearchText(ticket);
  const scored = typedPolicyBook.policies
    .map((policy) => scorePolicy(ticket, policy, searchText))
    .filter(({ policy, score }) => policy.alwaysInclude || score > 0)
    .sort((a, b) => b.score - a.score || a.policy.id.localeCompare(b.policy.id));

  const top = scored.slice(0, limit);
  const citations = top.map(({ policy, score, matchedTerms }) => ({
    id: policy.id,
    title: policy.title,
    source: policy.source,
    updatedAt: policy.updatedAt,
    citation: policy.citation,
    score,
    matchedTerms,
  }));

  return {
    version: typedPolicyBook.version,
    routeReason:
      citations.length > 0
        ? `Retrieved ${citations.length} policy ${citations.length === 1 ? "source" : "sources"} for this inbound ticket.`
        : "No policy source matched this inbound ticket; draft should stay conservative.",
    citations,
    context: toContext(top),
  };
}
