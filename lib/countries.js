/**
 * Dial codes for the country selector.
 *
 * Ordered by expected traffic rather than alphabetically: Kenya first (the
 * default), then the rest of East Africa, then the wider continent, then major
 * diaspora destinations. The selector shows them in this order, so this list is
 * also a product decision — not just a data table.
 */
export const COUNTRIES = [
  // ── East Africa ────────────────────────────────────────────────────────────
  { iso: 'KE', name: 'Kenya', dial: '254' },
  { iso: 'UG', name: 'Uganda', dial: '256' },
  { iso: 'TZ', name: 'Tanzania', dial: '255' },
  { iso: 'RW', name: 'Rwanda', dial: '250' },
  { iso: 'BI', name: 'Burundi', dial: '257' },
  { iso: 'SS', name: 'South Sudan', dial: '211' },
  { iso: 'ET', name: 'Ethiopia', dial: '251' },
  { iso: 'SO', name: 'Somalia', dial: '252' },
  { iso: 'DJ', name: 'Djibouti', dial: '253' },
  { iso: 'ER', name: 'Eritrea', dial: '291' },
  { iso: 'SD', name: 'Sudan', dial: '249' },

  // ── Rest of Africa ─────────────────────────────────────────────────────────
  { iso: 'NG', name: 'Nigeria', dial: '234' },
  { iso: 'GH', name: 'Ghana', dial: '233' },
  { iso: 'ZA', name: 'South Africa', dial: '27' },
  { iso: 'EG', name: 'Egypt', dial: '20' },
  { iso: 'MA', name: 'Morocco', dial: '212' },
  { iso: 'DZ', name: 'Algeria', dial: '213' },
  { iso: 'TN', name: 'Tunisia', dial: '216' },
  { iso: 'LY', name: 'Libya', dial: '218' },
  { iso: 'ZM', name: 'Zambia', dial: '260' },
  { iso: 'ZW', name: 'Zimbabwe', dial: '263' },
  { iso: 'MW', name: 'Malawi', dial: '265' },
  { iso: 'MZ', name: 'Mozambique', dial: '258' },
  { iso: 'BW', name: 'Botswana', dial: '267' },
  { iso: 'NA', name: 'Namibia', dial: '264' },
  { iso: 'LS', name: 'Lesotho', dial: '266' },
  { iso: 'SZ', name: 'Eswatini', dial: '268' },
  { iso: 'AO', name: 'Angola', dial: '244' },
  { iso: 'CM', name: 'Cameroon', dial: '237' },
  { iso: 'CI', name: "Côte d'Ivoire", dial: '225' },
  { iso: 'SN', name: 'Senegal', dial: '221' },
  { iso: 'ML', name: 'Mali', dial: '223' },
  { iso: 'BF', name: 'Burkina Faso', dial: '226' },
  { iso: 'NE', name: 'Niger', dial: '227' },
  { iso: 'BJ', name: 'Benin', dial: '229' },
  { iso: 'TG', name: 'Togo', dial: '228' },
  { iso: 'GN', name: 'Guinea', dial: '224' },
  { iso: 'SL', name: 'Sierra Leone', dial: '232' },
  { iso: 'LR', name: 'Liberia', dial: '231' },
  { iso: 'GM', name: 'Gambia', dial: '220' },
  { iso: 'CD', name: 'DR Congo', dial: '243' },
  { iso: 'CG', name: 'Congo', dial: '242' },
  { iso: 'GA', name: 'Gabon', dial: '241' },
  { iso: 'TD', name: 'Chad', dial: '235' },
  { iso: 'CF', name: 'Central African Republic', dial: '236' },
  { iso: 'MR', name: 'Mauritania', dial: '222' },

  // ── Middle East & Asia ─────────────────────────────────────────────────────
  { iso: 'AE', name: 'United Arab Emirates', dial: '971' },
  { iso: 'SA', name: 'Saudi Arabia', dial: '966' },
  { iso: 'QA', name: 'Qatar', dial: '974' },
  { iso: 'KW', name: 'Kuwait', dial: '965' },
  { iso: 'BH', name: 'Bahrain', dial: '973' },
  { iso: 'OM', name: 'Oman', dial: '968' },
  { iso: 'JO', name: 'Jordan', dial: '962' },
  { iso: 'LB', name: 'Lebanon', dial: '961' },
  { iso: 'IQ', name: 'Iraq', dial: '964' },
  { iso: 'TR', name: 'Türkiye', dial: '90' },
  { iso: 'IL', name: 'Israel', dial: '972' },
  { iso: 'IN', name: 'India', dial: '91' },
  { iso: 'PK', name: 'Pakistan', dial: '92' },
  { iso: 'BD', name: 'Bangladesh', dial: '880' },
  { iso: 'LK', name: 'Sri Lanka', dial: '94' },
  { iso: 'NP', name: 'Nepal', dial: '977' },
  { iso: 'CN', name: 'China', dial: '86' },
  { iso: 'JP', name: 'Japan', dial: '81' },
  { iso: 'KR', name: 'South Korea', dial: '82' },
  { iso: 'ID', name: 'Indonesia', dial: '62' },
  { iso: 'MY', name: 'Malaysia', dial: '60' },
  { iso: 'PH', name: 'Philippines', dial: '63' },
  { iso: 'VN', name: 'Vietnam', dial: '84' },
  { iso: 'TH', name: 'Thailand', dial: '66' },
  { iso: 'SG', name: 'Singapore', dial: '65' },

  // ── Europe ─────────────────────────────────────────────────────────────────
  { iso: 'GB', name: 'United Kingdom', dial: '44' },
  { iso: 'IE', name: 'Ireland', dial: '353' },
  { iso: 'DE', name: 'Germany', dial: '49' },
  { iso: 'FR', name: 'France', dial: '33' },
  { iso: 'NL', name: 'Netherlands', dial: '31' },
  { iso: 'BE', name: 'Belgium', dial: '32' },
  { iso: 'ES', name: 'Spain', dial: '34' },
  { iso: 'PT', name: 'Portugal', dial: '351' },
  { iso: 'IT', name: 'Italy', dial: '39' },
  { iso: 'CH', name: 'Switzerland', dial: '41' },
  { iso: 'AT', name: 'Austria', dial: '43' },
  { iso: 'SE', name: 'Sweden', dial: '46' },
  { iso: 'NO', name: 'Norway', dial: '47' },
  { iso: 'DK', name: 'Denmark', dial: '45' },
  { iso: 'FI', name: 'Finland', dial: '358' },
  { iso: 'PL', name: 'Poland', dial: '48' },
  { iso: 'CZ', name: 'Czechia', dial: '420' },
  { iso: 'GR', name: 'Greece', dial: '30' },
  { iso: 'RO', name: 'Romania', dial: '40' },
  { iso: 'UA', name: 'Ukraine', dial: '380' },
  { iso: 'RU', name: 'Russia', dial: '7' },

  // ── Americas & Oceania ─────────────────────────────────────────────────────
  { iso: 'US', name: 'United States', dial: '1' },
  { iso: 'CA', name: 'Canada', dial: '1' },
  { iso: 'MX', name: 'Mexico', dial: '52' },
  { iso: 'BR', name: 'Brazil', dial: '55' },
  { iso: 'AR', name: 'Argentina', dial: '54' },
  { iso: 'CL', name: 'Chile', dial: '56' },
  { iso: 'CO', name: 'Colombia', dial: '57' },
  { iso: 'PE', name: 'Peru', dial: '51' },
  { iso: 'VE', name: 'Venezuela', dial: '58' },
  { iso: 'EC', name: 'Ecuador', dial: '593' },
  { iso: 'BO', name: 'Bolivia', dial: '591' },
  { iso: 'PY', name: 'Paraguay', dial: '595' },
  { iso: 'UY', name: 'Uruguay', dial: '598' },
  { iso: 'AU', name: 'Australia', dial: '61' },
  { iso: 'NZ', name: 'New Zealand', dial: '64' },
]

export const DEFAULT_COUNTRY_ISO = 'KE'

export const DEFAULT_DIAL_CODE =
  COUNTRIES.find((c) => c.iso === DEFAULT_COUNTRY_ISO)?.dial || '254'

export function findCountryByIso(iso) {
  return COUNTRIES.find((c) => c.iso === iso) || null
}
