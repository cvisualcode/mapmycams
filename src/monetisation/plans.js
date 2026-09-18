// ─── Plan catalogue and entitlement logic ─────────────────────────────────────
// All pricing is in GBP. Stripe price IDs live in the backend env, referenced
// here only by plan key so the frontend never handles secrets.

export const PLANS = [
  {
    key: 'free',
    name: 'Free',
    price: 0,
    period: 'forever',
    blurb: 'Plan a single home layout with up to 4 cameras.',
    features: [
      '1 saved floorplan',
      'Up to 4 cameras',
      'Basic coverage visualisation',
      'PNG export (watermarked)',
      'No AI, security score, share links or PDF report',
    ],
    limits: { floorplans: 1, cameras: 4, ai: false, watermark: true, shareLinks: false, healthScore: false, premiumBrands: false, multiDevice: false, pdfReport: false },
    stripe: null,
    highlight: false,
  },
  {
    key: 'premium_monthly',
    name: 'Premium Monthly',
    price: 4.99,
    period: 'month',
    blurb: 'Everything unlocked, billed monthly. Cancel anytime.',
    features: [
      'Unlimited floorplans & cameras',
      'AI camera placement suggestions',
      'AI blind-spot detection',
      'Watermark-free PNG exports',
      'Security health score with fixes',
      'Shareable plan links',
      'PDF security report',
      'Multi-device sync',
      'Premium camera brands (Ring, Nest, Reolink…)',
    ],
    limits: { floorplans: Infinity, cameras: Infinity, ai: true, watermark: false, shareLinks: true, healthScore: true, premiumBrands: true, multiDevice: true, pdfReport: true },
    stripe: 'price_premium_monthly',
    highlight: true,
  },
  {
    key: 'premium_yearly',
    name: 'Premium Yearly',
    price: 49,
    period: 'year',
    blurb: 'Same as monthly — save ~£10.92 (2 months free).',
    features: [
      'Everything in Premium Monthly',
      '2 months free vs monthly',
      'Early access to new features',
    ],
    limits: { floorplans: Infinity, cameras: Infinity, ai: true, watermark: false, shareLinks: true, healthScore: true, premiumBrands: true, multiDevice: true, pdfReport: true },
    stripe: 'price_premium_yearly',
    highlight: false,
  },
]

// Every add-on here does something the tool actually does: an add-on with no
// feature behind it is a chargeback waiting to happen, so Family Sharing is gone
// until household seats are built for real.
export const ADDONS = [
  { key: 'ai_pack', name: 'Advanced AI Analysis Pack', price: 7.99, blurb: 'One-time. AI camera placement and blind-spot analysis on the Free tier — included with Premium.', stripe: 'price_ai_pack' },
  { key: 'pdf_report', name: 'Professional PDF Report', price: 4.99, blurb: 'One-time. A branded PDF security report of your plan, cameras and health score.', stripe: 'price_pdf_report' },
  { key: 'brands', name: 'Camera Brand Integration Pack', price: 6.99, blurb: 'One-time. Unlocks the branded camera models (Ring, Nest, Reolink) in the camera list.', stripe: 'price_brands' },
]

export const PREMIUM_BRANDS = ['Ring', 'Nest', 'Reolink', 'Eufy', 'Blink', 'Arlo']

/** Resolve a plan key to its limits object (falls back to Free). */
export function limitsFor(planKey) {
  const plan = PLANS.find((p) => p.key === planKey)
  return plan ? plan.limits : PLANS[0].limits
}

export function formatPrice(p) {
  return p === 0 ? 'Free' : `£${p.toFixed(2).replace(/\.00$/, '')}`
}
