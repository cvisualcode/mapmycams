// ─── Verification email ──────────────────────────────────────────────────────
// One template, shared by the deployed mailer (api/_lib.js) and the local
// `bun run email:test` script, so what you test is exactly what gets sent.

/**
 * Build the verification email for a 6-digit code.
 * @param {string} code   the 6-digit code to deliver
 * @param {string} [name] optional recipient name for the greeting
 * @returns {{ subject: string, text: string, html: string }}
 */
export function verificationEmail(code, name = '') {
  const hello = name ? `Hi ${name},` : 'Hi,'
  return {
    subject: `${code} is your MapMyCams verification code`,
    text: `${hello}\n\nYour MapMyCams verification code is ${code}.\n\n`
      + 'It expires in 10 minutes. If you did not create an account, you can ignore this email.',
    html: '<div style="font-family:system-ui,-apple-system,Segoe UI,sans-serif;max-width:480px;color:#0f172a">'
      + `<p style="margin:0 0 12px;color:#475569">${hello}</p>`
      + '<h2 style="margin:0 0 12px">Verify your email</h2>'
      + '<p style="color:#475569;margin:0 0 16px">Enter this code to finish creating your MapMyCams account.</p>'
      + `<p style="font-size:32px;font-weight:700;letter-spacing:6px;margin:0 0 16px">${code}</p>`
      + '<p style="color:#64748b;font-size:13px;margin:0">It expires in 10 minutes. '
      + 'If you did not create an account, you can ignore this email.</p>'
      + '</div>',
  }
}
