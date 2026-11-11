export type Profile = Record<string, string | undefined>;

// canonical profile key -> label/name/id patterns seen on real forms
const SYNONYMS: Record<string, RegExp> = {
  firstName: /^(first[\s_-]?name|fname|given[\s_-]?name|forename)$/i,
  lastName: /^(last[\s_-]?name|lname|surname|family[\s_-]?name)$/i,
  email: /^(e[\s_-]?mail(\s?address)?|email_?addr(ess)?)$/i,
  phone: /^(phone(\s?number)?|mobile|tel(ephone)?|cell)$/i,
  addressLine1: /^(address(\s?line)?\s?1?|street(\s?address)?)$/i,
  city: /^(city|town)$/i,
  postalCode: /^(zip(\s?code)?|postal[\s_-]?code|postcode)$/i,
  state: /^(state|province|region)$/i,
};

// Fields the software must NEVER fill. A person types these directly into the site.
const SENSITIVE_FIELD =
  /(social[\s_-]?security|\bssn\b|\bitin\b|tax[\s_-]?id|passport|driver'?s?[\s_-]?licen[sc]e|card[\s_-]?number|credit[\s_-]?card|\bcvv\b|\bcvc\b|routing[\s_-]?number|bank[\s_-]?account|account[\s_-]?number)/i;

export function isSensitiveField(labelOrName: string): boolean {
  return SENSITIVE_FIELD.test(labelOrName);
}

export function canonicalKey(fieldLabel: string): string | null {
  const l = fieldLabel.trim();
  for (const [k, re] of Object.entries(SYNONYMS)) if (re.test(l)) return k;
  return null;
}

export interface FormField { name: string; label: string; required: boolean }
export interface MappingResult {
  values: Record<string, string>;
  missing: string[];     // required fields we have no data for -> alert, never guess
  unmapped: string[];    // fields we don't recognize -> need adapter/human
  manual: string[];      // sensitive fields -> a human types these; never auto-filled, even if in the profile
}

export function mapFields(fields: FormField[], profile: Profile): MappingResult {
  const out: MappingResult = { values: {}, missing: [], unmapped: [], manual: [] };
  for (const f of fields) {
    if (isSensitiveField(f.label) || isSensitiveField(f.name)) { out.manual.push(f.name); continue; }
    const key = canonicalKey(f.label) ?? canonicalKey(f.name);
    if (!key) { out.unmapped.push(f.name); continue; }
    const v = profile[key];
    if (v !== undefined && v !== '') out.values[f.name] = v;
    else if (f.required) out.missing.push(f.name);
  }
  return out;
}
