// Sends the password-reset link via Resend (resend.com). Using its shared
// "onboarding@resend.dev" sender means no domain verification is needed --
// but that sender can only deliver to the email address on the Resend
// account itself, which is exactly RESET_EMAIL in our case anyway.
export async function sendResetEmail(env, toEmail, resetUrl) {
  const res = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${env.RESEND_API_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      from: "H2Oscar <onboarding@resend.dev>",
      to: [toEmail],
      subject: "Reset your H2Oscar dashboard password",
      html:
        "<p>Someone requested a password reset for your H2Oscar tank dashboard.</p>" +
        `<p><a href="${resetUrl}">Click here to set a new password</a>. This link works once and expires in 15 minutes.</p>` +
        "<p>If you didn't request this, you can safely ignore this email -- your password hasn't changed.</p>",
    }),
  });
  return res.ok;
}
