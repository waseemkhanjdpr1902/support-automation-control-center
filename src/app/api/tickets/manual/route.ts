import { handleRouteError, jsonOk } from "@/lib/api-utils";
import { createTicket } from "@/lib/store";
import { manualTicketSchema } from "@/lib/validation";

export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  try {
    const payload = manualTicketSchema.parse(await request.json());
    const ticket = await createTicket(
      {
        customerName: payload.customerName || "Customer",
        customerEmail: "not-provided@manual.invalid",
        subject: payload.subject || "Customer support request",
        body: payload.body,
        source: "manual",
        metadata: {
          capturedBy: "agent-copy-paste",
          responseTone: payload.responseTone,
        },
      },
      {
        action: "ticket_created",
        actor: "support-agent",
        message: "Customer email pasted manually for AI drafting.",
        metadata: { source: "manual", captureMode: "copy-paste" },
      },
    );

    return jsonOk({ ticket }, 201);
  } catch (error) {
    return handleRouteError(error);
  }
}
