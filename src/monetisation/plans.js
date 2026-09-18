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
      'No AI recommendations',
    ],
    limits: { floorplans: 1, cameras: 4, ai: false, watermark: true, shareLinks: false, healthScore: false, premiumBrands: false, multiDevice: false },
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
      'Watermark-free exports',
      'Priority rendering',
      'Multi-device sync',
      'Secure shareable links',
      'Home-security health score',
      'Premium camera brands (Ring, Nest, Reolink…)',
    ],
    limits: { floorplans: Infinity, cameras: Infinity, ai: true, watermark: false, shareLinks: true, healthScore: true, premiumBrands: true, multiDevice: true },
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
    limits: { floorplans: Infinity, cameras: Infinity, ai: true, watermark: false, shareLinks: true, healthScore: true, premiumBrands: true, multiDevice: true },
    stripe: 'price_premium_yearly',
    highlight: false,
  },
]

export const ADDONS = [
  { key: 'ai_pack', name: 'Advanced AI Analysis Pack', price: 7.99, blurb: 'One-time. Deep blind-spot analysis with prioritised fixes.', stripe: 'price_ai_pack' },
  { key: 'pdf_report', name: 'Professional PDF Report', price: 4.99, blurb: 'One-time. Branded multi-page security report export.', stripe: 'price_pdf_report' },
  { key: 'family', name: 'Family Sharing', price: 2.99, blurb: 'One-time. Share your subscription with up to 4 household members.', stripe: 'price_family' },
  { key: 'brands', name: 'Camera Brand Integration Pack', price: 6.99, blurb: 'One-time. Import real camera specs from supported brands.', stripe: 'price_brands' },
]

export const PREMIUM_BRANDS = ['Ring', 'Nest', 'Reolink', 'Eufy', 'Blink', 'Arlo']

/** Resolve a plan key to its limits object (falls back to Free). */
export function limitsFor(planKey) {
  const plan = PLANS.find((p) => p.key === planKey)
  return plan ? plan.limits : PLANS[0].limits
}

/** True when the user's plan/add-ons unlock a feature. */
export function hasFeature(ent, feature) {
  if (!ent || !ent.user) return false
  const limits = limitsFor(ent.plan)
  if (limits[feature]) return true
  // One-time add-ons also unlock the pieces of functionality they cover
  if (feature === 'ai' && (ent.addons || []).includes('ai_pack')) return true
  if (feature === 'pdfReport' && (ent.addons || []).includes('pdf_report')) return true
  if (feature === 'premiumBrands' && (ent.addons || []).includes('brands')) return true
  return false
}

export function formatPrice(p) {
  return p === 0 ? 'Free' : `£${p.toFixed(2).replace(/\.00$/, '')}`
}
