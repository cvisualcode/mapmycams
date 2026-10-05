// Legacy browser-generated codes cannot prove ownership of a server account.
// Accounts use the Worker's /auth/signup, /auth/resend and /auth/reset-request.
// Origin headers are not authentication and cannot secure an arbitrary mail relay.
export async function onRequestOptions() {
  return new Response(null, { status: 204 })
}

export async function onRequestPost() {
  return Response.json({ sent: false, error: 'Use the account verification service' }, {
    status: 410, headers: { 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' },
  })
}
