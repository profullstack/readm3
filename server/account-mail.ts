import type { SendMail } from "./accounts.ts";

/** No console/log fallback: failed delivery must never look like successful signup. */
export function accountMailer(apiKey = process.env.RESEND_API_KEY, from = process.env.READM3_MAIL_FROM): SendMail {
  return async ({ to, url }) => {
    if (!apiKey || !from) throw new Error("Email delivery is not configured");
    const response = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: { authorization: `Bearer ${apiKey}`, "content-type": "application/json" },
      signal: AbortSignal.timeout(15000),
      body: JSON.stringify({
        from, to: [to], subject: "Your readm3 sign-in link",
        text: `Sign in to readm3\n\nOpen this link to verify your email and sign in:\n${url}\n\nThis link expires in 15 minutes and can only be used once. If you didn't request it, you can ignore this email. Never forward this link.`,
        html: `<div style="font-family:system-ui,sans-serif;max-width:480px;margin:auto;padding:32px;color:#15202b"><h1>Sign in to readm3</h1><p>Verify your email and make yourself at home.</p><p style="margin:32px 0"><a href="${url}" style="background:#166534;color:white;padding:14px 22px;border-radius:6px;text-decoration:none">Verify email &amp; sign in</a></p><p>This link expires in 15 minutes and can only be used once.</p><p>If you didn't request it, you can ignore this email. Never forward this link.</p></div>`,
      }),
    });
    if (!response.ok) {
      console.error("Sign-in email delivery failed", response.status);
      throw new Error("Email provider rejected the message");
    }
  };
}
