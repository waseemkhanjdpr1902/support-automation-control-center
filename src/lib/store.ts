import { sampleTickets } from "./sample-data";
import { prisma, shouldUsePrisma } from "./prisma";
import type { Prisma } from "@prisma/client";
import type {
  AuditAction,
  AuditEventRecord,
  JsonObject,
  TicketIntent,
  TicketPriority,
  TicketRecord,
  TicketSentiment,
  TicketSource,
  TicketStatus,
} from "./types";
import type { InboundTicketInput } from "./validation";

type MemoryState = {
  tickets: TicketRecord[];
  seeded: boolean;
};

type TicketUpdate = Partial<
  Pick<
    TicketRecord,
    | "status"
    | "intent"
    | "sentiment"
    | "priority"
    | "aiDraft"
    | "finalResponse"
    | "aiProvider"
    | "aiModel"
    | "sendProvider"
    | "sendResult"
  >
>;

type AuditInput = {
  action: AuditAction;
  actor?: string;
  message: string;
  metadata?: JsonObject | null;
};

type PrismaTicket = Omit<TicketRecord, "auditEvents" | "createdAt" | "updatedAt"> & {
  createdAt: Date;
  updatedAt: Date;
  auditEvents?: PrismaAuditEvent[];
};

type PrismaAuditEvent = Omit<AuditEventRecord, "createdAt"> & {
  createdAt: Date;
};

const globalMemory = globalThis as unknown as {
  supportAgentMemory?: MemoryState;
};

function memoryState() {
  if (!globalMemory.supportAgentMemory) {
    globalMemory.supportAgentMemory = { tickets: [], seeded: false };
  }

  if (!globalMemory.supportAgentMemory.seeded) {
    globalMemory.supportAgentMemory.tickets = sampleTickets.map((ticket, index) =>
      makeMemoryTicket(ticket, index),
    );
    globalMemory.supportAgentMemory.seeded = true;
  }

  return globalMemory.supportAgentMemory;
}

function nowIso() {
  return new Date().toISOString();
}

function makeId(prefix: string) {
  return `${prefix}_${Math.random().toString(36).slice(2, 10)}${Date.now().toString(36)}`;
}

function makeMemoryTicket(input: InboundTicketInput, index = 0): TicketRecord {
  const created = new Date(Date.now() - (sampleTickets.length - index) * 8 * 60 * 1000).toISOString();
  const id = makeId("ticket");

  return {
    id,
    customerName: input.customerName,
    customerEmail: input.customerEmail,
    subject: input.subject,
    body: input.body,
    source: input.source,
    status: "new",
    intent: "general_support",
    sentiment: "neutral",
    priority: "normal",
    aiDraft: null,
    finalResponse: null,
    aiProvider: null,
    aiModel: null,
    sendProvider: null,
    sendResult: null,
    metadata: input.metadata ?? null,
    createdAt: created,
    updatedAt: created,
    auditEvents: [
      {
        id: makeId("audit"),
        ticketId: id,
        action: "ticket_created",
        actor: "sample-loader",
        message: "Inbound message captured for human review.",
        metadata: { source: input.source },
        createdAt: created,
      },
    ],
  };
}

function normalizeSource(value: string): TicketSource {
  const allowed: TicketSource[] = ["manual", "demo", "webhook", "gmail", "zendesk", "intercom", "lead_form"];
  return allowed.includes(value as TicketSource) ? (value as TicketSource) : "webhook";
}

function normalizeStatus(value: string): TicketStatus {
  const allowed: TicketStatus[] = [
    "new",
    "drafted",
    "needs_review",
    "approved",
    "sent",
    "simulated",
    "failed",
  ];
  return allowed.includes(value as TicketStatus) ? (value as TicketStatus) : "new";
}

function normalizeIntent(value: string): TicketIntent {
  const allowed: TicketIntent[] = [
    "refund_request",
    "billing_issue",
    "angry_complaint",
    "lead_inquiry",
    "technical_support",
    "general_support",
  ];
  return allowed.includes(value as TicketIntent) ? (value as TicketIntent) : "general_support";
}

function normalizeSentiment(value: string): TicketSentiment {
  const allowed: TicketSentiment[] = ["positive", "neutral", "frustrated", "angry"];
  return allowed.includes(value as TicketSentiment) ? (value as TicketSentiment) : "neutral";
}

function normalizePriority(value: string): TicketPriority {
  const allowed: TicketPriority[] = ["low", "normal", "high", "urgent"];
  return allowed.includes(value as TicketPriority) ? (value as TicketPriority) : "normal";
}

function normalizeAction(value: string): AuditAction {
  const allowed: AuditAction[] = [
    "ticket_created",
    "seeded",
    "ai_drafted",
    "safety_flagged",
    "draft_edited",
    "submitted_for_review",
    "returned_for_changes",
    "approved",
    "sent",
    "send_simulated",
    "send_failed",
  ];
  return allowed.includes(value as AuditAction) ? (value as AuditAction) : "ticket_created";
}

function normalizeMetadata(value: unknown): JsonObject | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }

  return value as JsonObject;
}

function toPrismaJson(value: JsonObject | null | undefined): Prisma.InputJsonValue | undefined {
  return value ? (value as Prisma.InputJsonValue) : undefined;
}

function fromPrisma(ticket: PrismaTicket): TicketRecord {
  return {
    ...ticket,
    source: normalizeSource(ticket.source),
    status: normalizeStatus(ticket.status),
    intent: normalizeIntent(ticket.intent),
    sentiment: normalizeSentiment(ticket.sentiment),
    priority: normalizePriority(ticket.priority),
    metadata: normalizeMetadata(ticket.metadata),
    createdAt: ticket.createdAt.toISOString(),
    updatedAt: ticket.updatedAt.toISOString(),
    auditEvents: (ticket.auditEvents ?? []).map((event) => ({
      ...event,
      action: normalizeAction(event.action),
      metadata: normalizeMetadata(event.metadata),
      createdAt: event.createdAt.toISOString(),
    })),
  };
}

export async function listTickets() {
  if (shouldUsePrisma()) {
    const tickets = await prisma.ticket.findMany({
      orderBy: { createdAt: "desc" },
      include: { auditEvents: { orderBy: { createdAt: "desc" } } },
    });
    return tickets.map((ticket) => fromPrisma(ticket as PrismaTicket));
  }

  return [...memoryState().tickets].sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

export async function getTicket(id: string) {
  if (shouldUsePrisma()) {
    const ticket = await prisma.ticket.findUnique({
      where: { id },
      include: { auditEvents: { orderBy: { createdAt: "desc" } } },
    });
    return ticket ? fromPrisma(ticket as PrismaTicket) : null;
  }

  return memoryState().tickets.find((ticket) => ticket.id === id) ?? null;
}

export async function createTicket(input: InboundTicketInput, audit?: AuditInput) {
  const auditEvent = audit ?? {
    action: "ticket_created" as const,
    actor: "webhook",
    message: "Inbound message captured for human review.",
    metadata: { source: input.source },
  };

  if (shouldUsePrisma()) {
    const ticket = await prisma.ticket.create({
      data: {
        customerName: input.customerName,
        customerEmail: input.customerEmail,
        subject: input.subject,
        body: input.body,
        source: input.source,
        metadata: toPrismaJson(input.metadata),
        auditEvents: {
          create: {
            action: auditEvent.action,
            actor: auditEvent.actor ?? "system",
            message: auditEvent.message,
            metadata: toPrismaJson(auditEvent.metadata),
          },
        },
      },
      include: { auditEvents: { orderBy: { createdAt: "desc" } } },
    });
    return fromPrisma(ticket as PrismaTicket);
  }

  const ticket = makeMemoryTicket(input);
  ticket.auditEvents[0] = {
    ...ticket.auditEvents[0],
    action: auditEvent.action,
    actor: auditEvent.actor ?? "system",
    message: auditEvent.message,
    metadata: auditEvent.metadata ?? null,
  };
  memoryState().tickets.unshift(ticket);
  return ticket;
}

export async function updateTicket(id: string, data: TicketUpdate, audit?: AuditInput) {
  if (shouldUsePrisma()) {
    const ticket = await prisma.ticket.update({
      where: { id },
      data: {
        ...data,
        auditEvents: audit
          ? {
              create: {
                action: audit.action,
                actor: audit.actor ?? "system",
                message: audit.message,
                metadata: toPrismaJson(audit.metadata),
              },
            }
          : undefined,
      },
      include: { auditEvents: { orderBy: { createdAt: "desc" } } },
    });
    return fromPrisma(ticket as PrismaTicket);
  }

  const state = memoryState();
  const ticket = state.tickets.find((item) => item.id === id);

  if (!ticket) {
    return null;
  }

  Object.assign(ticket, data, { updatedAt: nowIso() });

  if (audit) {
    ticket.auditEvents.unshift({
      id: makeId("audit"),
      ticketId: id,
      action: audit.action,
      actor: audit.actor ?? "system",
      message: audit.message,
      metadata: audit.metadata ?? null,
      createdAt: nowIso(),
    });
  }

  return ticket;
}

export async function seedSampleTickets() {
  if (shouldUsePrisma()) {
    const sampleEmails = sampleTickets.map((ticket) => ticket.customerEmail);

    await prisma.ticket.deleteMany({
      where: {
        OR: [{ source: "demo" }, { customerEmail: { in: sampleEmails } }],
      },
    });

    const created = [];
    for (const ticket of sampleTickets) {
      created.push(
        await createTicket(ticket, {
          action: "seeded",
          actor: "sample-loader",
          message: "Sample ticket loaded into the review queue.",
          metadata: { source: ticket.source },
        }),
      );
    }
    return created;
  }

  globalMemory.supportAgentMemory = { tickets: [], seeded: false };
  return memoryState().tickets;
}
