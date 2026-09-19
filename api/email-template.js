// ─── Account emails ──────────────────────────────────────────────────────────
// Two templates, shared by the deployed mailer (api/_lib.js) and the local
// `bun run email:test` script, so what you test is exactly what gets sent: one to
// prove an address at signup, one to reset a forgotten password. They are kept
// apart on purpose — "verify your email" is the wrong thing to read when what you
// asked for was a new password.

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

/**
 * Build the password-reset email for a 6-digit code.
 *
 * It says what to do, how long it lasts, and — because this is the one email an
 * attacker would like to trigger — that ignoring it is safe. The account is not
 * touched until the code comes back.
 */
export function passwordResetEmail(code, name = '') {
  const hello = name ? `Hi ${name},` : 'Hi,'
  return {
    subject: `${code} is your MapMyCams password reset code`,
    text: `${hello}\n\nYour MapMyCams password reset code is ${code}.\n\n`
      + 'Enter it on the reset screen to choose a new password. It expires in 10 minutes, and you can ignore\n'
      + 'this email if you did not ask for it — nothing has changed.',
    html: '<div style="font-family:system-ui,-apple-system,Segoe UI,sans-serif;max-width:480px;color:#0f172a">'
      + `<p style="margin:0 0 12px;color:#475569">${hello}</p>`
      + '<h2 style="margin:0 0 12px">Choose a new password</h2>'
      + '<p style="color:#475569;margin:0 0 16px">Enter this code on the reset screen to set a new password for your MapMyCams account.</p>'
      + `<p style="font-size:32px;font-weight:700;letter-spacing:6px;margin:0 0 16px">${code}</p>`
      + '<p style="color:#64748b;font-size:13px;margin:0">It expires in 10 minutes. If you did not ask for a reset, '
      + 'you can ignore this email — nothing about your account has changed.</p>'
      + '</div>',
  }
}
