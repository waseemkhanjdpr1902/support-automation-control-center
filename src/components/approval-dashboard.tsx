"use client";

import {
  Activity,
  Bot,
  CheckCircle2,
  Clipboard,
  Clock3,
  Database,
  Edit3,
  Inbox,
  Loader2,
  MailCheck,
  RefreshCw,
  Route,
  ShieldAlert,
  ShieldCheck,
  Sparkles,
  UserCheck,
  Workflow,
} from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { clsx } from "clsx";
import type { SafetyCheckResult, SafetySeverity } from "@/lib/safety";
import type { AuditEventRecord, TicketRecord, TicketStatus } from "@/lib/types";

type TicketResponse = {
  ticket: TicketRecord;
};

type TicketsResponse = {
  tickets: TicketRecord[];
};

type ActionState = {
  message: string;
  tone: "ok" | "warn" | "error";
};

type FilterKey = "all" | "review" | "risk" | "delivered";
type EvidenceTab = "run" | "policy" | "safety" | "audit";

type ModelRun = {
  provider: string | null;
  model: string | null;
  latencyMs: number | null;
  estimatedCostUsd: number | null;
  routeReason: string | null;
  inputTokens: number | null;
  outputTokens: number | null;
  totalTokens: number | null;
  hasTelemetry: boolean;
  isLegacy: boolean;
};

type PolicyCitationView = {
  id: string;
  title: string;
  source: string;
  citation: string;
  score: number | null;
  matchedTerms: string[];
};

type PolicyGroundingView = {
  version: string | null;
  routeReason: string | null;
  citations: PolicyCitationView[];
};

const statusStyles: Record<TicketStatus, string> = {
  new: "border-slate-200 bg-slate-100 text-slate-700",
  drafted: "border-blue-200 bg-blue-50 text-blue-700",
  needs_review: "border-amber-200 bg-amber-50 text-amber-800",
  approved: "border-emerald-200 bg-emerald-50 text-emerald-700",
  sent: "border-emerald-200 bg-emerald-50 text-emerald-700",
  simulated: "border-violet-200 bg-violet-50 text-violet-700",
  failed: "border-red-200 bg-red-50 text-red-700",
};

const priorityStyles: Record<string, string> = {
  low: "bg-slate-100 text-slate-600",
  normal: "bg-cyan-50 text-cyan-700",
  high: "bg-amber-50 text-amber-800",
  urgent: "bg-red-50 text-red-700",
};

const severityStyles: Record<SafetySeverity, string> = {
  none: "border-emerald-200 bg-emerald-50 text-emerald-700",
  low: "border-blue-200 bg-blue-50 text-blue-700",
  medium: "border-amber-200 bg-amber-50 text-amber-800",
  high: "border-red-200 bg-red-50 text-red-700",
};

const reviewStatuses: TicketStatus[] = ["new", "drafted", "needs_review"];
const deliveredStatuses: TicketStatus[] = ["approved", "sent", "simulated"];

function label(value: string) {
  return value.replaceAll("_", " ");
}

function displayLabel(value: string) {
  if (value === "send_simulated") return "delivery staged";
  if (value === "simulated") return "staged";
  if (value === "ai_drafted") return "ai drafted";
  if (value === "safety_flagged") return "safety flagged";
  return value === "demo" ? "sample" : label(value);
}

function formatTime(value: string) {
  return new Intl.DateTimeFormat("en", {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  }).format(new Date(value));
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function asNumber(value: unknown) {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function asString(value: unknown) {
  return typeof value === "string" ? value : null;
}

function latestEvent(ticket: TicketRecord | null, action: string) {
  return ticket?.auditEvents.find((event) => event.action === action) ?? null;
}

function eventMetadata(event: AuditEventRecord | null) {
  return asRecord(event?.metadata);
}

function getSafety(ticket: TicketRecord | null): SafetyCheckResult | null {
  const safetyEvent =
    latestEvent(ticket, "safety_flagged") ??
    latestEvent(ticket, "approved") ??
    latestEvent(ticket, "ai_drafted");
  const metadata = eventMetadata(safetyEvent);
  const safety = asRecord(metadata?.safety);

  if (!safety) return null;

  return safety as SafetyCheckResult;
}

function getModelRun(ticket: TicketRecord | null): ModelRun | null {
  const metadata = eventMetadata(latestEvent(ticket, "ai_drafted"));
  const provider = asString(metadata?.provider) ?? ticket?.aiProvider ?? null;
  const model = asString(metadata?.model) ?? ticket?.aiModel ?? null;
  if (!metadata && !provider && !model) return null;

  const usage = asRecord(metadata?.usage);
  const latencyMs = asNumber(metadata?.latencyMs);
  const estimatedCostUsd = asNumber(metadata?.estimatedCostUsd);
  const inputTokens = asNumber(usage?.inputTokens);
  const outputTokens = asNumber(usage?.outputTokens);
  const totalTokens = asNumber(usage?.totalTokens);
  const hasTelemetry =
    latencyMs !== null ||
    estimatedCostUsd !== null ||
    inputTokens !== null ||
    outputTokens !== null ||
    totalTokens !== null ||
    Boolean(asString(metadata?.routeReason));

  return {
    provider,
    model,
    latencyMs,
    estimatedCostUsd,
    routeReason: asString(metadata?.routeReason),
    inputTokens,
    outputTokens,
    totalTokens,
    hasTelemetry,
    isLegacy: !hasTelemetry && Boolean(model || provider),
  };
}

function getPolicyGrounding(ticket: TicketRecord | null): PolicyGroundingView | null {
  const metadata = eventMetadata(latestEvent(ticket, "ai_drafted"));
  const grounding = asRecord(metadata?.policyGrounding);
  const rawCitations = Array.isArray(grounding?.citations) ? grounding.citations : [];
  const citations = rawCitations
    .map((value) => {
      const citation = asRecord(value);

      if (!citation) return null;

      return {
        id: asString(citation.id) ?? "unknown",
        title: asString(citation.title) ?? "Untitled policy",
        source: asString(citation.source) ?? "Unknown source",
        citation: asString(citation.citation) ?? "No citation text recorded.",
        score: asNumber(citation.score),
        matchedTerms: Array.isArray(citation.matchedTerms)
          ? citation.matchedTerms.filter((term): term is string => typeof term === "string")
          : [],
      };
    })
    .filter((citation): citation is PolicyCitationView => citation !== null);

  if (!grounding && citations.length === 0) return null;

  return {
    version: asString(grounding?.version),
    routeReason: asString(grounding?.routeReason),
    citations,
  };
}

function getWebhookEvidence(ticket: TicketRecord | null) {
  const metadata = eventMetadata(latestEvent(ticket, "ticket_created"));
  return {
    security: asString(metadata?.webhookSecurity),
    executionId: asString(metadata?.n8nExecutionId),
  };
}

function formatCost(value: number | null) {
  if (value === null) return "rates not set";
  if (value === 0) return "$0.000000";
  return `$${value.toFixed(value < 0.01 ? 6 : 4)}`;
}

function formatModelRunCost(run: ModelRun) {
  if (
    run.estimatedCostUsd === null &&
    run.provider === "zai" &&
    run.model === "glm-4.7-flash" &&
    run.totalTokens !== null
  ) {
    return "$0.000000";
  }

  return formatCost(run.estimatedCostUsd);
}

function formatTokens(value: number | null) {
  return value === null ? "not captured" : value.toLocaleString();
}

function formatMetadataKey(value: string) {
  const labels: Record<string, string> = {
    accountPlan: "Account plan",
    capturedBy: "Captured by",
    channel: "Channel",
    companySize: "Company size",
    n8nExecutionId: "n8n execution",
    opportunity: "Opportunity",
    policy: "Policy note",
    rawSource: "Raw source",
    receivedAt: "Received",
    routedBy: "Routed by",
  };

  if (labels[value]) return labels[value];

  return value
    .replace(/([A-Z])/g, " $1")
    .replaceAll("_", " ")
    .replace(/^./, (character) => character.toUpperCase());
}

function formatMetadataValue(key: string, value: unknown) {
  if (value === null || value === undefined) return "Not provided";

  if (key === "receivedAt" && typeof value === "string") {
    return formatTime(value);
  }

  if (typeof value === "object") {
    return JSON.stringify(value);
  }

  return String(value);
}

function metadataEntries(metadata: TicketRecord["metadata"]) {
  const record = asRecord(metadata);
  if (!record) return [];

  const preferredOrder = [
    "routedBy",
    "channel",
    "rawSource",
    "receivedAt",
    "n8nExecutionId",
    "accountPlan",
    "companySize",
    "opportunity",
    "policy",
  ];
  const keys = Object.keys(record).sort((a, b) => {
    const aIndex = preferredOrder.indexOf(a);
    const bIndex = preferredOrder.indexOf(b);

    if (aIndex === -1 && bIndex === -1) return a.localeCompare(b);
    if (aIndex === -1) return 1;
    if (bIndex === -1) return -1;
    return aIndex - bIndex;
  });

  return keys.map((key) => ({
    key,
    label: formatMetadataKey(key),
    value: formatMetadataValue(key, record[key]),
  }));
}

async function requestJson<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await fetch(url, {
    ...init,
    headers: {
      "Content-Type": "application/json",
      ...(init?.headers ?? {}),
    },
  });

  const payload = (await response.json()) as T & { error?: string };

  if (!response.ok) {
    throw new Error(payload.error || "Request failed.");
  }

  return payload;
}

export function ApprovalDashboard() {
  const [tickets, setTickets] = useState<TicketRecord[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [draftTextById, setDraftTextById] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState<string | null>(null);
  const [actionState, setActionState] = useState<ActionState | null>(null);
  const [filter, setFilter] = useState<FilterKey>("all");
  const [activeEvidenceTab, setActiveEvidenceTab] = useState<EvidenceTab>("run");
  const [manualEmail, setManualEmail] = useState("");
  const [manualSubject, setManualSubject] = useState("");
  const [manualCustomer, setManualCustomer] = useState("");
  const [responseTone, setResponseTone] = useState("professional");

  const metrics = useMemo(() => {
    const waiting = tickets.filter((ticket) => reviewStatuses.includes(ticket.status)).length;
    const risky = tickets.filter((ticket) => getSafety(ticket)?.severity === "high").length;
    const delivered = tickets.filter((ticket) => deliveredStatuses.includes(ticket.status)).length;
    return { waiting, risky, delivered };
  }, [tickets]);

  const filteredTickets = useMemo(() => {
    if (filter === "review") {
      return tickets.filter((ticket) => reviewStatuses.includes(ticket.status));
    }

    if (filter === "risk") {
      return tickets.filter((ticket) => getSafety(ticket)?.severity === "high");
    }

    if (filter === "delivered") {
      return tickets.filter((ticket) => deliveredStatuses.includes(ticket.status));
    }

    return tickets;
  }, [filter, tickets]);

  const selected = useMemo(
    () =>
      filteredTickets.find((ticket) => ticket.id === selectedId) ??
      filteredTickets[0] ??
      tickets.find((ticket) => ticket.id === selectedId) ??
      tickets[0] ??
      null,
    [filteredTickets, selectedId, tickets],
  );
  const draftText = selected
    ? draftTextById[selected.id] ?? selected.finalResponse ?? selected.aiDraft ?? ""
    : "";
  const selectedSafety = getSafety(selected);
  const modelRun = getModelRun(selected);
  const policyGrounding = getPolicyGrounding(selected);
  const webhookEvidence = getWebhookEvidence(selected);
  const selectedMetadata = metadataEntries(selected?.metadata ?? null);
  const visibleActionState = actionState?.message === "Inbox synced." ? null : actionState;

  function upsertTicket(ticket: TicketRecord | null | undefined) {
    if (!ticket) return;
    setTickets((current) => {
      const exists = current.some((item) => item.id === ticket.id);
      const next = exists
        ? current.map((item) => (item.id === ticket.id ? ticket : item))
        : [ticket, ...current];
      return next.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
    });
    setSelectedId(ticket.id);
  }

  function selectTicket(ticketId: string) {
    setSelectedId(ticketId);
    setActiveEvidenceTab("run");
  }

  function updateDraftText(value: string) {
    if (!selected) return;
    setDraftTextById((current) => ({ ...current, [selected.id]: value }));
  }

  async function loadTickets() {
    setBusy("load");
    try {
      const data = await requestJson<TicketsResponse>("/api/tickets");
      setTickets(data.tickets);
      setSelectedId((current) => current ?? data.tickets[0]?.id ?? null);
      setActionState({ message: "Inbox synced.", tone: "ok" });
    } catch (error) {
      setActionState({
        message: error instanceof Error ? error.message : "Could not load tickets.",
        tone: "error",
      });
    } finally {
      setBusy(null);
    }
  }

  async function seedSamples() {
    setBusy("seed");
    try {
      const data = await requestJson<TicketsResponse>("/api/samples/seed", { method: "POST" });
      setTickets(data.tickets);
      setSelectedId(data.tickets[0]?.id ?? null);
      setActionState({ message: "Sample tickets loaded.", tone: "ok" });
    } catch (error) {
      setActionState({
        message: error instanceof Error ? error.message : "Could not load sample tickets.",
        tone: "error",
      });
    } finally {
      setBusy(null);
    }
  }

  async function createManualDraft() {
    if (manualEmail.trim().length < 10) {
      setActionState({ message: "Paste the customer email before generating a draft.", tone: "warn" });
      return;
    }

    setBusy("manual-draft");
    try {
      const created = await requestJson<TicketResponse>("/api/tickets/manual", {
        method: "POST",
        body: JSON.stringify({
          customerName: manualCustomer || undefined,
          subject: manualSubject || undefined,
          body: manualEmail,
          responseTone,
        }),
      });
      upsertTicket(created.ticket);

      const drafted = await requestJson<TicketResponse>(`/api/tickets/${created.ticket.id}/draft`, {
        method: "POST",
      });
      upsertTicket(drafted.ticket);
      setDraftTextById((current) => ({
        ...current,
        [drafted.ticket.id]: drafted.ticket.finalResponse ?? drafted.ticket.aiDraft ?? "",
      }));
      setManualEmail("");
      setManualSubject("");
      setManualCustomer("");
      setActionState({ message: "Draft generated from the pasted customer email.", tone: "ok" });
    } catch (error) {
      setActionState({
        message: error instanceof Error ? error.message : "Could not generate the draft.",
        tone: "error",
      });
    } finally {
      setBusy(null);
    }
  }

  async function copyDraft() {
    if (!draftText.trim()) return;
    try {
      await navigator.clipboard.writeText(draftText);
      setActionState({ message: "Response copied. Paste it into your email application.", tone: "ok" });
    } catch {
      setActionState({ message: "Copy failed. Select the response text and copy it manually.", tone: "error" });
    }
  }

  async function draftResponse() {
    if (!selected) return;
    setBusy("draft");
    try {
      const data = await requestJson<TicketResponse>(`/api/tickets/${selected.id}/draft`, {
        method: "POST",
      });
      upsertTicket(data.ticket);
      setDraftTextById((current) => ({
        ...current,
        [data.ticket.id]: data.ticket.finalResponse ?? data.ticket.aiDraft ?? "",
      }));
      setActiveEvidenceTab("run");

      const safety = getSafety(data.ticket);
      setActionState({
        message:
          safety && safety.severity !== "none"
            ? `Draft created with ${safety.severity} safety review.`
            : data.ticket.aiProvider === "anthropic" || data.ticket.aiProvider === "zai"
              ? `${data.ticket.aiProvider === "zai" ? "Z.ai GLM" : "Claude"} drafted the response.`
              : "Fallback draft generated because live AI is not configured.",
        tone:
          safety && safety.severity !== "none"
            ? "warn"
            : data.ticket.aiProvider === "anthropic" || data.ticket.aiProvider === "zai"
              ? "ok"
              : "warn",
      });
    } catch (error) {
      setActionState({
        message: error instanceof Error ? error.message : "Could not draft response.",
        tone: "error",
      });
    } finally {
      setBusy(null);
    }
  }

  async function saveEdit() {
    if (!selected) return;
    setBusy("save");
    try {
      const data = await requestJson<TicketResponse>(`/api/tickets/${selected.id}`, {
        method: "PATCH",
        body: JSON.stringify({ finalResponse: draftText }),
      });
      upsertTicket(data.ticket);
      setActionState({ message: "Human edit saved.", tone: "ok" });
    } catch (error) {
      setActionState({
        message: error instanceof Error ? error.message : "Could not save edit.",
        tone: "error",
      });
    } finally {
      setBusy(null);
    }
  }

  useEffect(() => {
    let isActive = true;

    async function loadInitialTickets() {
      setBusy("load");
      try {
        const data = await requestJson<TicketsResponse>("/api/tickets");
        if (!isActive) return;
        setTickets(data.tickets);
        setSelectedId(data.tickets[0]?.id ?? null);
        setActionState({ message: "Inbox synced.", tone: "ok" });
      } catch (error) {
        if (!isActive) return;
        setActionState({
          message: error instanceof Error ? error.message : "Could not load tickets.",
          tone: "error",
        });
      } finally {
        if (isActive) {
          setBusy(null);
        }
      }
    }

    void loadInitialTickets();

    return () => {
      isActive = false;
    };
  }, []);

  return (
    <main className="min-h-screen bg-[#f6f7f8] text-slate-950">
      <div className="border-b border-slate-200 bg-white">
        <div className="mx-auto flex max-w-[1680px] flex-col gap-4 px-4 py-4 sm:px-6 lg:px-8">
          <div className="flex flex-col justify-between gap-4 lg:flex-row lg:items-center">
            <div className="min-w-0">
              <div className="mb-1.5 flex items-center gap-2 text-xs font-semibold uppercase text-teal-700">
                <Workflow className="size-4" />
                paste customer email | AI draft | agent review
              </div>
              <h1 className="text-[26px] font-semibold leading-tight text-slate-950">
                Fintech Email Reply Assistant
              </h1>
            </div>
            <div className="flex flex-wrap gap-2">
              <button
                className="inline-flex h-10 items-center gap-2 rounded-md border border-slate-200 bg-white px-3 text-sm font-medium text-slate-700 shadow-sm transition hover:border-slate-300 hover:bg-slate-50 disabled:cursor-not-allowed disabled:opacity-60"
                onClick={loadTickets}
                disabled={busy !== null}
                title="Refresh inbox"
              >
                <RefreshCw className={clsx("size-4", busy === "load" && "animate-spin")} />
                Refresh
              </button>
              <button
                className="inline-flex h-10 items-center gap-2 rounded-md border border-slate-200 bg-white px-3 text-sm font-medium text-slate-700 shadow-sm transition hover:border-slate-300 hover:bg-slate-50 disabled:cursor-not-allowed disabled:opacity-60"
                onClick={seedSamples}
                disabled={busy !== null}
                title="Load sample tickets"
              >
                <Database className="size-4" />
                Samples
              </button>
            </div>
          </div>

          <div className="grid gap-2 md:grid-cols-4">
            <StatusStripItem
              icon={Clipboard}
              label="Intake"
              value="copy & paste"
              tone="teal"
            />
            <StatusStripItem
              icon={Bot}
              label="AI draft"
              value={selected?.aiDraft ? "ready" : "pending"}
              tone={selected?.aiDraft ? "blue" : "slate"}
            />
            <StatusStripItem
              icon={Database}
              label="Policy"
              value={policyGrounding ? `${policyGrounding.citations.length} sources` : "pending"}
              tone={policyGrounding ? "teal" : "slate"}
            />
            <StatusStripItem
              icon={selectedSafety?.severity === "high" ? ShieldAlert : CheckCircle2}
              label="Safety"
              value={selectedSafety ? selectedSafety.severity === "none" ? "pass" : selectedSafety.severity : "pending"}
              tone={selectedSafety?.severity === "high" ? "red" : selectedSafety ? "green" : "slate"}
            />
          </div>
        </div>
      </div>

      <div className="mx-auto grid max-w-[1680px] items-start gap-5 px-4 py-5 sm:px-6 lg:h-[calc(100vh-9.75rem)] lg:min-h-[720px] lg:grid-cols-[360px_minmax(0,1fr)] lg:overflow-hidden lg:px-8">
        <section className="rounded-md border border-slate-200 bg-white shadow-sm lg:flex lg:h-full lg:min-h-0 lg:flex-col lg:overflow-hidden">
          <div className="border-b border-slate-200 bg-teal-50/60 p-4">
            <div className="mb-3">
              <p className="font-semibold text-slate-950">Paste customer email</p>
              <p className="mt-1 text-xs leading-5 text-slate-600">No mailbox connection is required. Customer details are optional.</p>
            </div>
            <div className="space-y-2">
              <input
                className="h-9 w-full rounded-md border border-slate-200 bg-white px-3 text-sm outline-none focus:border-teal-500 focus:ring-2 focus:ring-teal-100"
                value={manualCustomer}
                onChange={(event) => setManualCustomer(event.target.value)}
                placeholder="Customer name (optional)"
              />
              <input
                className="h-9 w-full rounded-md border border-slate-200 bg-white px-3 text-sm outline-none focus:border-teal-500 focus:ring-2 focus:ring-teal-100"
                value={manualSubject}
                onChange={(event) => setManualSubject(event.target.value)}
                placeholder="Email subject (optional)"
              />
              <textarea
                className="min-h-32 w-full resize-y rounded-md border border-slate-200 bg-white p-3 text-sm leading-6 outline-none focus:border-teal-500 focus:ring-2 focus:ring-teal-100"
                value={manualEmail}
                onChange={(event) => setManualEmail(event.target.value)}
                placeholder="Paste the complete customer email here…"
              />
              <div className="grid grid-cols-[1fr_auto] gap-2">
                <select
                  className="h-10 rounded-md border border-slate-200 bg-white px-3 text-sm outline-none focus:border-teal-500"
                  value={responseTone}
                  onChange={(event) => setResponseTone(event.target.value)}
                >
                  <option value="professional">Professional</option>
                  <option value="empathetic">Empathetic</option>
                  <option value="apology">Apology</option>
                  <option value="firm">Firm</option>
                  <option value="escalation">Escalation</option>
                </select>
                <button
                  className="inline-flex h-10 items-center justify-center gap-2 rounded-md bg-teal-700 px-4 text-sm font-medium text-white hover:bg-teal-800 disabled:opacity-60"
                  onClick={createManualDraft}
                  disabled={busy !== null || manualEmail.trim().length < 10}
                >
                  {busy === "manual-draft" ? <Loader2 className="size-4 animate-spin" /> : <Sparkles className="size-4" />}
                  Generate
                </button>
              </div>
            </div>
          </div>
          <div className="border-b border-slate-200 p-4">
            <div className="mb-3 flex items-center justify-between gap-3">
              <div className="flex items-center gap-2 font-semibold">
                <Inbox className="size-4 text-slate-500" />
                Queue
              </div>
              <span className="text-sm text-slate-500">{filteredTickets.length} shown</span>
            </div>
            <div className="grid grid-cols-2 gap-2">
              <FilterButton active={filter === "all"} label="All" count={tickets.length} onClick={() => setFilter("all")} />
              <FilterButton active={filter === "review"} label="Review" count={metrics.waiting} onClick={() => setFilter("review")} />
              <FilterButton active={filter === "risk"} label="Risk" count={metrics.risky} onClick={() => setFilter("risk")} />
              <FilterButton active={filter === "delivered"} label="Done" count={metrics.delivered} onClick={() => setFilter("delivered")} />
            </div>
          </div>

          <div className="max-h-[760px] space-y-2 overflow-y-auto p-3 lg:min-h-0 lg:flex-1 lg:max-h-none">
            {busy === "load" && tickets.length === 0 ? (
              <EmptyState icon={Loader2} title="Syncing inbox" text="Waiting for ticket records." spin />
            ) : filteredTickets.length === 0 ? (
              <EmptyState
                icon={Inbox}
                title={tickets.length === 0 ? "No tickets yet" : "No tickets in this view"}
                text={tickets.length === 0 ? "Paste a customer email above to create the first draft." : "Change the queue filter."}
              />
            ) : (
              filteredTickets.map((ticket) => (
                <TicketButton
                  key={ticket.id}
                  ticket={ticket}
                  selected={selected?.id === ticket.id}
                  safety={getSafety(ticket)}
                  onClick={() => selectTicket(ticket.id)}
                />
              ))
            )}
          </div>
        </section>

        <section className="rounded-md border border-slate-200 bg-white shadow-sm lg:h-full lg:min-h-0 lg:overflow-hidden">
          {selected ? (
            <div className="flex h-full min-h-0 flex-col">
              <div className="border-b border-slate-200 px-5 py-4">
                <div className="flex flex-col justify-between gap-3 xl:flex-row xl:items-start">
                  <div className="min-w-0">
                    <div className="mb-2 flex flex-wrap items-center gap-2">
                      <StatusBadge status={selected.status} />
                      <span className="rounded-full bg-slate-100 px-2.5 py-1 text-xs font-medium capitalize text-slate-600">
                        {displayLabel(selected.source)}
                      </span>
                      {selectedSafety ? <SafetyBadge safety={selectedSafety} /> : null}
                    </div>
                    <h2 className="text-[22px] font-semibold leading-tight text-slate-950">
                      {selected.subject}
                    </h2>
                    <p className="mt-1 text-sm text-slate-500">
                      {selected.customerName}{selected.source !== "manual" ? ` | ${selected.customerEmail}` : ""}
                    </p>
                  </div>
                  <button
                    className="inline-flex h-9 shrink-0 items-center justify-center gap-2 rounded-md bg-teal-700 px-4 text-sm font-medium text-white transition hover:bg-teal-800 disabled:cursor-not-allowed disabled:opacity-60"
                    onClick={draftResponse}
                    disabled={busy !== null}
                    title={selected.aiDraft ? "Reclassify and draft again" : "Classify and draft"}
                  >
                    {busy === "draft" ? (
                      <Loader2 className="size-4 animate-spin" />
                    ) : (
                      <Sparkles className="size-4" />
                    )}
                    {selected.aiDraft ? "Re-draft" : "Draft"}
                  </button>
                </div>

                <div className="mt-4 grid gap-2 sm:grid-cols-4">
                  <Signal label="Intent" value={label(selected.intent)} />
                  <Signal label="Sentiment" value={label(selected.sentiment)} />
                  <Signal label="Priority" value={label(selected.priority)} />
                  <Signal label="Source" value={displayLabel(selected.source)} />
                </div>
                {visibleActionState ? <ActionBanner actionState={visibleActionState} /> : null}
              </div>

              <div className="grid min-h-0 flex-1 lg:grid-cols-[minmax(0,1fr)_350px] 2xl:grid-cols-[minmax(0,1fr)_380px]">
                <div className="min-h-0 overflow-y-auto">
                  <section className="border-b border-slate-200 px-6 py-5">
                    <SectionTitle icon={MailCheck} title="Incoming request" />
                    <p className="mt-3 max-w-4xl whitespace-pre-wrap text-[15px] leading-7 text-slate-700">
                      {selected.body}
                    </p>
                    {selectedMetadata.length > 0 ? (
                      <div className="mt-5">
                        <div className="mb-3 flex items-center justify-between gap-3">
                          <p className="text-xs font-semibold uppercase text-slate-500">
                            Workflow context
                          </p>
                          {selected.source === "webhook" ? (
                            <span className="rounded-full bg-teal-50 px-2.5 py-1 text-xs font-medium text-teal-700">
                              n8n captured
                            </span>
                          ) : null}
                        </div>
                        <dl className="grid gap-2 sm:grid-cols-2">
                          {selectedMetadata.map((item) => (
                            <ContextFact key={item.key} label={item.label} value={item.value} />
                          ))}
                        </dl>
                      </div>
                    ) : null}
                  </section>

                  <section className="px-6 py-5">
                    <div className="mb-3 flex items-center justify-between gap-3">
                      <SectionTitle icon={Edit3} title="Response under review" />
                      <span className="text-xs text-slate-500">
                        {selected.aiProvider ? `${selected.aiProvider} | ${selected.aiModel}` : "No draft yet"}
                      </span>
                    </div>
                    <textarea
                      className="min-h-[400px] w-full resize-y rounded-md border border-slate-200 bg-white p-4 text-base leading-7 text-slate-800 outline-none transition focus:border-teal-500 focus:ring-2 focus:ring-teal-100"
                      value={draftText}
                      onChange={(event) => updateDraftText(event.target.value)}
                      placeholder="Draft appears here after classification."
                    />
                    <div className="mt-4 flex flex-col gap-3 xl:flex-row xl:items-end xl:justify-end">
                      <div className="flex flex-col gap-2 sm:flex-row">
                        <button
                          className="inline-flex h-10 items-center justify-center gap-2 whitespace-nowrap rounded-md border border-slate-200 bg-white px-4 text-sm font-medium text-slate-700 transition hover:bg-slate-50 disabled:cursor-not-allowed disabled:opacity-60"
                          onClick={saveEdit}
                          disabled={busy !== null || !draftText.trim()}
                          title="Save human edit"
                        >
                          {busy === "save" ? <Loader2 className="size-4 animate-spin" /> : <UserCheck className="size-4" />}
                          Save edit
                        </button>
                        <button
                          className="inline-flex h-10 items-center justify-center gap-2 whitespace-nowrap rounded-md bg-slate-950 px-4 text-sm font-medium text-white transition hover:bg-slate-800 disabled:cursor-not-allowed disabled:opacity-60"
                          onClick={copyDraft}
                          disabled={busy !== null || !draftText.trim()}
                          title="Copy response"
                        >
                          <Clipboard className="size-4" />
                          Copy response
                        </button>
                      </div>
                    </div>
                  </section>
                </div>

                <aside className="flex min-h-0 flex-col border-t border-slate-200 bg-slate-50/60 lg:h-full lg:overflow-hidden lg:border-l lg:border-t-0">
                  <div className="border-b border-slate-200 bg-white px-3 py-2.5">
                    <div className="mb-2 flex items-center justify-between gap-3">
                      <div>
                        <p className="text-sm font-semibold text-slate-950">Evidence</p>
                      </div>
                    </div>
                    <div className="grid grid-cols-4 gap-1 rounded-md bg-slate-100 p-1">
                      <EvidenceTabButton active={activeEvidenceTab === "run"} label="Run" onClick={() => setActiveEvidenceTab("run")} />
                      <EvidenceTabButton active={activeEvidenceTab === "policy"} label="Policy" onClick={() => setActiveEvidenceTab("policy")} />
                      <EvidenceTabButton active={activeEvidenceTab === "safety"} label="Safety" onClick={() => setActiveEvidenceTab("safety")} />
                      <EvidenceTabButton active={activeEvidenceTab === "audit"} label="Audit" onClick={() => setActiveEvidenceTab("audit")} />
                    </div>
                  </div>
                  <div className="min-h-0 flex-1 overflow-y-auto p-3">
                    {activeEvidenceTab === "run" ? (
                      <EvidenceRun modelRun={modelRun} webhookEvidence={webhookEvidence} selected={selected} />
                    ) : null}
                    {activeEvidenceTab === "policy" ? (
                      <EvidencePolicy policyGrounding={policyGrounding} />
                    ) : null}
                    {activeEvidenceTab === "safety" ? (
                      <EvidenceSafety safety={selectedSafety} />
                    ) : null}
                    {activeEvidenceTab === "audit" ? (
                      <EvidenceAudit events={selected.auditEvents} />
                    ) : null}
                  </div>
                </aside>
              </div>
            </div>
          ) : (
            <EmptyState icon={Inbox} title="No ticket selected" text="Select a ticket from the queue." tall />
          )}
        </section>
      </div>
    </main>
  );
}

function StatusStripItem({
  icon: Icon,
  label: stripLabel,
  value,
  tone,
}: {
  icon: typeof Inbox;
  label: string;
  value: string;
  tone: "blue" | "green" | "red" | "teal" | "slate";
}) {
  return (
    <div className="flex min-h-12 items-center gap-3 rounded-md border border-slate-200 bg-slate-50 px-3 py-2">
      <div
        className={clsx(
          "flex size-8 shrink-0 items-center justify-center rounded-md",
          tone === "blue" && "bg-blue-50 text-blue-700",
          tone === "green" && "bg-emerald-50 text-emerald-700",
          tone === "red" && "bg-red-50 text-red-700",
          tone === "teal" && "bg-teal-50 text-teal-700",
          tone === "slate" && "bg-white text-slate-500",
        )}
      >
        <Icon className="size-4" />
      </div>
      <div className="min-w-0">
        <p className="text-xs font-medium text-slate-500">{stripLabel}</p>
        <p className="truncate text-sm font-semibold capitalize text-slate-900">{value}</p>
      </div>
    </div>
  );
}

function SectionTitle({ icon: Icon, title }: { icon: typeof Inbox; title: string }) {
  return (
    <div className="flex items-center gap-2 text-sm font-semibold text-slate-900">
      <Icon className="size-4 text-slate-500" />
      {title}
    </div>
  );
}

function ContextFact({ label: contextLabel, value }: { label: string; value: string }) {
  return (
    <div className="rounded-md border border-slate-100 bg-slate-50 px-3 py-2">
      <dt className="text-xs font-medium text-slate-500">{contextLabel}</dt>
      <dd className="mt-1 break-words text-sm font-semibold text-slate-800">{value}</dd>
    </div>
  );
}

function EvidenceTabButton({
  active,
  label: tabLabel,
  onClick,
}: {
  active: boolean;
  label: string;
  onClick: () => void;
}) {
  return (
    <button
      className={clsx(
        "h-7 rounded text-xs font-semibold transition",
        active ? "bg-white text-slate-950 shadow-sm" : "text-slate-500 hover:text-slate-800",
      )}
      onClick={onClick}
    >
      {tabLabel}
    </button>
  );
}

function ActionBanner({ actionState }: { actionState: ActionState }) {
  return (
    <div
      className={clsx(
        "mt-4 rounded-md border px-3 py-2 text-sm",
        actionState.tone === "ok" && "border-emerald-200 bg-emerald-50 text-emerald-800",
        actionState.tone === "warn" && "border-amber-200 bg-amber-50 text-amber-900",
        actionState.tone === "error" && "border-red-200 bg-red-50 text-red-800",
      )}
    >
      {actionState.message}
    </div>
  );
}

function EvidenceRun({
  modelRun,
  webhookEvidence,
  selected,
}: {
  modelRun: ModelRun | null;
  webhookEvidence: ReturnType<typeof getWebhookEvidence>;
  selected: TicketRecord;
}) {
  return (
    <div className="space-y-4">
      <div>
        <SectionTitle icon={Route} title="Workflow run" />
        <div className="mt-3 grid gap-2">
          <EvidenceFact label="Source" value={displayLabel(selected.source)} />
          <EvidenceFact
            label="Webhook secret"
            value={
              webhookEvidence.security === "verified"
                ? "verified"
                : webhookEvidence.security === "not_configured"
                  ? "dev mode"
                  : "not captured"
            }
          />
          <EvidenceFact label="n8n execution" value={webhookEvidence.executionId ?? "not captured"} />
        </div>
      </div>

      <div className="border-t border-slate-200 pt-4">
        <SectionTitle icon={Activity} title="Model run" />
        {modelRun ? (
          <div className="mt-3 grid gap-2">
            {modelRun.isLegacy ? (
              <div className="rounded-md border border-amber-200 bg-amber-50 p-3 text-xs leading-5 text-amber-900">
                Legacy draft. Click Re-draft before recording to capture V2 telemetry.
              </div>
            ) : null}
            <EvidenceFact label="Provider" value={modelRun.provider ?? "not captured"} />
            <EvidenceFact label="Model" value={modelRun.model ?? "unknown"} />
            <EvidenceFact label="Latency" value={modelRun.latencyMs === null ? "not captured" : `${modelRun.latencyMs} ms`} />
            <EvidenceFact label="Input tokens" value={formatTokens(modelRun.inputTokens)} />
            <EvidenceFact label="Output tokens" value={formatTokens(modelRun.outputTokens)} />
            <EvidenceFact label="Total tokens" value={formatTokens(modelRun.totalTokens)} />
            <EvidenceFact label="Cost" value={formatModelRunCost(modelRun)} />
            <p className="pt-1 text-xs leading-5 text-slate-500">
              {modelRun.routeReason ??
                (modelRun.isLegacy ? "Legacy draft metadata only includes the model name." : "Provider did not return a route note.")}
            </p>
          </div>
        ) : (
          <p className="mt-3 text-sm leading-6 text-slate-500">No model run recorded.</p>
        )}
      </div>
    </div>
  );
}

function EvidencePolicy({ policyGrounding }: { policyGrounding: PolicyGroundingView | null }) {
  if (!policyGrounding) {
    return <p className="text-sm leading-6 text-slate-500">No policy source recorded.</p>;
  }

  return (
    <div>
      <SectionTitle icon={Database} title="Policy grounding" />
      <p className="mt-3 text-sm leading-6 text-slate-500">
        {policyGrounding.routeReason ?? "Policy sources retrieved for this draft."}
      </p>
      <div className="mt-3 space-y-3">
        {policyGrounding.citations.map((citation) => (
          <div key={citation.id} className="rounded-md border border-slate-200 bg-white p-3">
            <div className="mb-1 flex items-start justify-between gap-2">
              <p className="text-sm font-semibold text-slate-900">{citation.title}</p>
              {citation.score !== null ? (
                <span className="rounded-full bg-slate-100 px-2 py-1 text-xs font-medium text-slate-500">
                  {citation.score}
                </span>
              ) : null}
            </div>
            <p className="text-xs leading-5 text-slate-500">{citation.source}</p>
            <p className="mt-2 text-sm leading-6 text-slate-700">{citation.citation}</p>
            {citation.matchedTerms.length > 0 ? (
              <div className="mt-3 flex flex-wrap gap-1">
                {citation.matchedTerms.slice(0, 5).map((term) => (
                  <MetaPill key={`${citation.id}-${term}`} text={term} />
                ))}
              </div>
            ) : null}
          </div>
        ))}
      </div>
    </div>
  );
}

function EvidenceSafety({ safety }: { safety: SafetyCheckResult | null }) {
  return (
    <div>
      <SectionTitle icon={ShieldCheck} title="Safety gate" />
      <div className="mt-3">
        {safety ? (
          <SafetyPanel safety={safety} />
        ) : (
          <p className="text-sm leading-6 text-slate-500">No safety result recorded.</p>
        )}
      </div>
    </div>
  );
}

function EvidenceAudit({ events }: { events: AuditEventRecord[] }) {
  return (
    <div>
      <SectionTitle icon={Clock3} title="Audit trail" />
      <div className="mt-3 space-y-3">
        {events.map((event) => (
          <div key={event.id} className="border-l-2 border-slate-200 pl-3">
            <p className="text-sm font-semibold capitalize text-slate-900">{displayLabel(event.action)}</p>
            <p className="mt-1 text-xs leading-5 text-slate-500">{event.message}</p>
            {event.metadata ? <AuditMetadata metadata={event.metadata} /> : null}
            <p className="mt-1 text-xs text-slate-400">
              {event.actor} | {formatTime(event.createdAt)}
            </p>
          </div>
        ))}
      </div>
    </div>
  );
}

function FilterButton({
  active,
  label: filterLabel,
  count,
  onClick,
}: {
  active: boolean;
  label: string;
  count: number;
  onClick: () => void;
}) {
  return (
    <button
      className={clsx(
        "flex h-9 items-center justify-between rounded-lg border px-3 text-sm font-medium transition",
        active
          ? "border-slate-900 bg-slate-950 text-white"
          : "border-slate-200 bg-white text-slate-700 hover:bg-slate-50",
      )}
      onClick={onClick}
    >
      <span>{filterLabel}</span>
      <span className={clsx("text-xs", active ? "text-slate-200" : "text-slate-400")}>{count}</span>
    </button>
  );
}

function TicketButton({
  ticket,
  selected,
  safety,
  onClick,
}: {
  ticket: TicketRecord;
  selected: boolean;
  safety: SafetyCheckResult | null;
  onClick: () => void;
}) {
  return (
    <button
      className={clsx(
        "w-full rounded-lg border p-3 text-left transition",
        selected
          ? "border-slate-900 bg-slate-50 shadow-sm"
          : "border-slate-200 bg-white hover:border-slate-300 hover:bg-slate-50",
      )}
      onClick={onClick}
    >
      <div className="mb-2 flex items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="truncate text-sm font-semibold text-slate-950">{ticket.customerName}</p>
          <p className="truncate text-xs text-slate-500">{ticket.customerEmail}</p>
        </div>
        <StatusBadge status={ticket.status} />
      </div>
      <p className="line-clamp-2 text-sm font-medium text-slate-800">{ticket.subject}</p>
      <div className="mt-3 flex items-center justify-between gap-2">
        <div className="flex flex-wrap items-center gap-2">
          <span
            className={clsx(
              "rounded-full px-2 py-1 text-xs font-medium capitalize",
              priorityStyles[ticket.priority],
            )}
          >
            {label(ticket.priority)}
          </span>
          {safety && safety.severity !== "none" ? <SafetyBadge safety={safety} compact /> : null}
        </div>
        <span className="text-xs text-slate-500">{formatTime(ticket.createdAt)}</span>
      </div>
    </button>
  );
}

function StatusBadge({ status }: { status: TicketStatus }) {
  return (
    <span
      className={clsx(
        "inline-flex shrink-0 rounded-full border px-2 py-1 text-xs font-medium capitalize",
        statusStyles[status],
      )}
    >
      {displayLabel(status)}
    </span>
  );
}

function SafetyBadge({
  safety,
  compact = false,
}: {
  safety: SafetyCheckResult | null;
  compact?: boolean;
}) {
  const severity = safety?.severity ?? "none";
  return (
    <span
      className={clsx(
        "inline-flex shrink-0 rounded-full border px-2 py-1 text-xs font-medium capitalize",
        severityStyles[severity],
      )}
    >
      {compact ? severity : `safety ${severity}`}
    </span>
  );
}

function Signal({ label: signalLabel, value }: { label: string; value: string }) {
  return (
    <div className="rounded-md border border-slate-200 bg-slate-50 px-3 py-2.5">
      <p className="text-xs font-medium uppercase text-slate-500">{signalLabel}</p>
      <p className="mt-1 truncate text-sm font-semibold capitalize text-slate-900">{value}</p>
    </div>
  );
}

function EvidenceFact({ label: factLabel, value }: { label: string; value: string }) {
  return (
    <div className="flex items-start justify-between gap-3 border-b border-slate-100 pb-2 text-[13px] last:border-0 last:pb-0">
      <span className="text-slate-500">{factLabel}</span>
      <span className="min-w-0 break-words text-right font-semibold text-slate-800">{value}</span>
    </div>
  );
}

function SafetyPanel({ safety }: { safety: SafetyCheckResult }) {
  return (
    <div
      className={clsx(
        "rounded-lg border p-3 text-sm",
        severityStyles[safety.severity],
      )}
    >
      <div className="mb-2 flex items-center justify-between gap-3">
        <span className="font-semibold capitalize">{safety.severity} risk</span>
        <span>{safety.passed ? "pass" : "blocked"}</span>
      </div>
      <p className="leading-5">{safety.summary}</p>
      {safety.flags.length > 0 ? (
        <div className="mt-3 space-y-2">
          {safety.flags.map((flag) => (
            <div key={`${flag.code}-${flag.message}`} className="rounded-md bg-white/70 p-2">
              <p className="font-medium">{flag.label}</p>
              <p className="mt-1 leading-5">{flag.message}</p>
            </div>
          ))}
        </div>
      ) : null}
    </div>
  );
}

function AuditMetadata({ metadata }: { metadata: Record<string, unknown> }) {
  const model = asString(metadata.model);
  const latency = asNumber(metadata.latencyMs);
  const estimatedCost = asNumber(metadata.estimatedCostUsd);
  const safety = asRecord(metadata.safety) as SafetyCheckResult | null;
  const policyGrounding = asRecord(metadata.policyGrounding);
  const policyCount = Array.isArray(policyGrounding?.citations)
    ? policyGrounding.citations.length
    : 0;

  if (!model && latency === null && estimatedCost === null && !safety && policyCount === 0) {
    return null;
  }

  return (
    <div className="mt-2 flex flex-wrap gap-1.5">
      {model ? <MetaPill text={model} /> : null}
      {latency !== null ? <MetaPill text={`${latency} ms`} /> : null}
      {estimatedCost !== null ? <MetaPill text={formatCost(estimatedCost)} /> : null}
      {policyCount > 0 ? <MetaPill text={`${policyCount} policies`} /> : null}
      {safety ? <MetaPill text={`safety ${safety.severity}`} /> : null}
    </div>
  );
}

function MetaPill({ text }: { text: string }) {
  return (
    <span className="rounded-full bg-slate-100 px-2 py-1 text-xs font-medium text-slate-600">
      {text}
    </span>
  );
}

function EmptyState({
  icon: Icon,
  title,
  text,
  spin = false,
  tall = false,
}: {
  icon: typeof Inbox;
  title: string;
  text: string;
  spin?: boolean;
  tall?: boolean;
}) {
  return (
    <div className={clsx("flex flex-col items-center justify-center p-6 text-center", tall && "min-h-[520px]")}>
      <Icon className={clsx("mb-3 size-7 text-slate-400", spin && "animate-spin")} />
      <p className="font-semibold text-slate-800">{title}</p>
      <p className="mt-1 text-sm leading-6 text-slate-500">{text}</p>
    </div>
  );
}
