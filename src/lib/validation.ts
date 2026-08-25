import { z } from "zod";
import { ticketSources } from "./types";

export const inboundTicketSchema = z.object({
  customerName: z.string().trim().min(1, "Customer name is required"),
  customerEmail: z.string().trim().email("A valid customer email is required"),
  subject: z.string().trim().min(1, "Subject is required"),
  body: z.string().trim().min(1, "Message body is required"),
  source: z.enum(ticketSources).default("webhook"),
  metadata: z.record(z.string(), z.unknown()).optional(),
});

export const manualTicketSchema = z.object({
  customerName: z.string().trim().max(120).optional().default("Customer"),
  subject: z.string().trim().max(240).optional().default("Customer support request"),
  body: z.string().trim().min(10, "Paste at least 10 characters from the customer email"),
  responseTone: z
    .enum(["professional", "empathetic", "apology", "firm", "escalation"])
    .default("professional"),
});

export const updateTicketSchema = z.object({
  finalResponse: z.string().trim().min(1).optional(),
});

export const approveTicketSchema = z.object({
  passcode: z.string().optional(),
  finalResponse: z.string().trim().min(1).optional(),
});

export type InboundTicketInput = z.infer<typeof inboundTicketSchema>;
