// Notification channels for the daily alert engine.
//
// - Slack: a single incoming-webhook URL (coordinator channel). Optional.
// - Email: Resend transactional API. Optional — skipped if RESEND_API_KEY unset.
//
// Both degrade gracefully: if a channel isn't configured, we log and move on
// rather than failing the whole cron run. That lets the team go live on Slack
// first and add email later without a code change.

export interface NotifyConfig {
  slackWebhookUrl?: string;
  resendApiKey?: string;
  emailFrom?: string;
  dryRun: boolean;
}

export type Channel = "slack" | "email";

export interface OutgoingMessage {
  subject: string; // used as email subject / Slack bold header
  body: string; // plain text
  channels: Channel[];
  emailTo?: string[]; // required when channels includes "email"
}

export interface NotifyOutcome {
  slackSent: boolean;
  emailSent: boolean;
  skipped: string[]; // reasons a channel was skipped
}

export class Notifier {
  constructor(private readonly cfg: NotifyConfig) {}

  async send(msg: OutgoingMessage): Promise<NotifyOutcome> {
    const outcome: NotifyOutcome = { slackSent: false, emailSent: false, skipped: [] };

    if (this.cfg.dryRun) {
      console.log(`[dry-run] would notify [${msg.channels.join(",")}]: ${msg.subject}`);
      outcome.skipped.push("dry-run");
      return outcome;
    }

    if (msg.channels.includes("slack")) {
      if (this.cfg.slackWebhookUrl) {
        await this.sendSlack(msg);
        outcome.slackSent = true;
      } else {
        outcome.skipped.push("slack: no SLACK_WEBHOOK_URL");
        console.log(`[no-slack] ${msg.subject}`);
      }
    }

    if (msg.channels.includes("email")) {
      if (this.cfg.resendApiKey && this.cfg.emailFrom && msg.emailTo?.length) {
        await this.sendEmail(msg);
        outcome.emailSent = true;
      } else {
        outcome.skipped.push("email: not configured");
        console.log(`[no-email] ${msg.subject}`);
      }
    }

    return outcome;
  }

  private async sendSlack(msg: OutgoingMessage): Promise<void> {
    const res = await fetch(this.cfg.slackWebhookUrl!, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text: `*${msg.subject}*\n${msg.body}` }),
    });
    if (!res.ok) {
      throw new Error(`Slack webhook failed ${res.status}: ${await res.text()}`);
    }
  }

  private async sendEmail(msg: OutgoingMessage): Promise<void> {
    const res = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${this.cfg.resendApiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        from: this.cfg.emailFrom,
        to: msg.emailTo,
        subject: msg.subject,
        text: msg.body,
      }),
    });
    if (!res.ok) {
      throw new Error(`Resend email failed ${res.status}: ${await res.text()}`);
    }
  }
}
