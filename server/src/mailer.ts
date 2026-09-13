export interface Mailer {
  sendCode(to: string, code: string): Promise<void>;
}

/** Dev default: the code is printed on the validator's console. */
export class ConsoleMailer implements Mailer {
  async sendCode(to: string, code: string) {
    console.log(`[wrk] sign-in code for ${to}: ${code}`);
  }
}

/** Real delivery through Resend's HTTP API (needs RESEND_API_KEY and WRK_MAIL_FROM). */
export class ResendMailer implements Mailer {
  constructor(private readonly apiKey: string, private readonly from: string) {}
  async sendCode(to: string, code: string) {
    const res = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: { authorization: `Bearer ${this.apiKey}`, "content-type": "application/json" },
      body: JSON.stringify({
        from: this.from,
        to,
        subject: `Your Wrk code is ${code}`,
        text: `Your Wrk sign-in code is ${code}. It expires in 10 minutes. If you didn't ask for it, ignore this email.`,
      }),
    });
    if (!res.ok) throw new Error(`Mail provider returned ${res.status}`);
  }
}
