interface McpToolDefinition {
  name: string;
  description: string;
  /** Human-facing one-liner (fleet #1967). Optional; consumers fall back to
   *  description. Kept in step with shared/src/types.ts — scripts/lib/
   *  check-inlined-types.mjs reports drift at publish time. */
  summary?: string;
  inputSchema: {
    type: 'object';
    properties: Record<string, unknown>;
    required?: string[];
    anyOf?: Array<{ required: string[] }>;
    oneOf?: Array<{ required: string[] }>;
    allOf?: Array<{ required: string[] }>;
  };
  outputSchema?: Record<string, unknown>;
}

interface McpToolExport {
  tools: McpToolDefinition[];
  callTool: (name: string, args: Record<string, unknown>) => Promise<unknown>;
  meter?: { credits: number };
  cost?: Record<string, unknown>;
  provider?: string;
}

/**
 * New York State OMIG Medicaid provider exclusion screening — fleet #2788.
 *
 * Beside the federal HHS OIG LEIE (mcps/leie) and the SAM federal exclusions
 * list, New York runs its own Medicaid exclusion list through the Office of
 * the Medicaid Inspector General (OMIG): providers barred from billing or
 * participating in NY's Medicaid program. This is that list, for New York
 * only — one pack per jurisdiction (root CLAUDE.md rule 5); the next state
 * is a separate pack filed on this task's close.
 *
 * SOURCE AND SHAPE. OMIG publishes the list only as flat-file exports behind
 * apps.omig.ny.gov/exclusions/ — tab-delimited text, an Excel export, and an
 * HTML "formatted list" (6.5MB of markup for the same ~9,100 rows the
 * tab-delimited export gives at ~535KB) — no JSON/REST endpoint of any kind.
 * Verified live 2026-10-07 from BOTH a laptop curl and a throwaway
 * `wrangler dev --remote` Worker on the prod account: identical 200 /
 * 535,395 bytes from the Cloudflare edge, so unlike oklahoma-code / utah-code
 * / new-hampshire-code this host needs no Supabase egress relay.
 *
 * Root CLAUDE.md's standing rule 3 (this task) still applies regardless of
 * reachability: a baked table this size (~1.3MB as generated TS) never sits
 * in gateway module scope. It is baked by
 * mcps/ny-omig-exclusions/scripts/bake-index.mjs into
 * src/ny-omig-index-data.ts, registered in
 * workers/gateway/src/pack-baked-indexes.json, uploaded to KV at deploy
 * (scripts/sync-gateway-static-json.mjs), and injected here as
 * `args._bakedIndex` — the exact pattern usgs-mineral-commodities and the
 * six baked state-code packs use, adopted here for the same reason
 * (fleet #2754: six packs' worth of static imports put ~48MB of retained
 * heap into every isolate and cost about one gateway call in four as
 * Cloudflare 1102).
 *
 * This is an official NY State public enforcement record that OMIG
 * publishes specifically so providers, payers and the public can screen
 * against it — baking a copy needs no reuse grant, and publishing matches
 * is not the "personal data" carve-out (that covers bulk-redistributing
 * private details, not an official sanctions list a regulator publishes for
 * exactly this purpose).
 *
 * NO EXCLUSION REASON/AUTHORITY FIELD EXISTS IN THIS DATA. Unlike the
 * federal LEIE (which carries a statutory exclusion-type code), every OMIG
 * export — tab-delimited, Excel, and the formatted HTML list — carries only
 * provider name, license number, NPI, provider type and the exclusion
 * effective date. Per-record detail (if OMIG holds any) sits behind an
 * ASP.NET VIEWSTATE postback tied to a freshly-loaded search session, not a
 * stable queryable endpoint, and was not pursued for this first cut. Every
 * response here says so plainly rather than inventing a field OMIG does not
 * publish.
 *
 * MATCHING MODEL, same shape as LEIE's: an NPI or license-number match
 * identifies a specific provider (both are OMIG-assigned/verified
 * identifiers). A name match — even an exact one — is a CANDIDATE, never an
 * identification: common names repeat, and this list carries no date of
 * birth or address to disambiguate people the way LEIE's DOB field does.
 * match_confidence on every record says plainly which kind it got.
 *
 * Keyless.
 */
import type { NyOmigRow } from './ny-omig-index-data.js';

// fleet #2754 / root CLAUDE.md rule 3 — the baked table (~1.3MB, 9,117 rows)
// is injected by the gateway as `args._bakedIndex`, loaded from KV once per
// isolate. NEVER value-import ./ny-omig-index-data.js here — only the
// type-only import above, which is erased at compile time. A value import
// puts the whole table back in the bundle and into every isolate's heap;
// scripts/check-gateway-bundle-size.mjs fails the deploy if that happens.
let ROWS: NyOmigRow[] = [];
let DATA_AS_OF = '';
let SOURCE_URL = '';
let SEARCH_URL = '';
let CAPTURED_AT = '';
let TOTAL_ROWS = 0;

function ensureIndex(args: Record<string, unknown>): void {
  if (ROWS.length) return;
  const idx = args._bakedIndex as Record<string, unknown> | null | undefined;
  const rows = idx?.NY_OMIG_ROWS;
  if (!Array.isArray(rows) || rows.length === 0) {
    // Loud on purpose (root CLAUDE.md rule 2): answering "no exclusion
    // found" from an empty table would be a silent wrong answer,
    // indistinguishable from a real clean screening result.
    throw new Error(
      `ny-omig-exclusions: the baked OMIG exclusion index is unavailable (${idx == null ? 'not injected' : 'malformed'}). ` +
        'The gateway loads it from KV on the first call into this pack; this is a server-side fault, not a bad query — retry shortly.',
    );
  }
  ROWS = rows as NyOmigRow[];
  DATA_AS_OF = String(idx?.NY_OMIG_DATA_AS_OF ?? '');
  SOURCE_URL = String(idx?.NY_OMIG_SOURCE_URL ?? 'https://apps.omig.ny.gov/exclusions/tabdelimited.aspx');
  SEARCH_URL = String(idx?.NY_OMIG_SEARCH_URL ?? 'https://apps.omig.ny.gov/exclusions/ex_search.aspx');
  CAPTURED_AT = String(idx?.NY_OMIG_CAPTURED_AT ?? '');
  TOTAL_ROWS = Number(idx?.NY_OMIG_TOTAL_ROWS ?? ROWS.length);
}

const SOURCE_LABEL = 'New York State Office of the Medicaid Inspector General (OMIG) — Restricted, Terminated and Excluded Individuals/Entities List';

const NO_REASON_CAVEAT =
  'OMIG\'s published exports do not include an exclusion reason, statutory authority or case citation (unlike the federal HHS OIG LEIE, which carries a statutory code) — only name, license number, NPI, provider type and the exclusion effective date. This is everything OMIG publishes; it is not a trimmed-down view.';

const NOT_AN_ANSWER =
  'Name matches are CANDIDATES, not identifications — this list carries no date of birth or address to tell same-named people apart. Only an NPI or license-number match identifies a specific provider. Confirm a name match against the provider\'s NPI or license before acting on it.';

function normalize(s: string): string {
  return s.toUpperCase().replace(/[^A-Z0-9 ]/g, ' ').replace(/\s+/g, ' ').trim();
}

function digitsOnly(s: string): string {
  return s.replace(/\D/g, '');
}

type MatchType = 'npi_match' | 'license_match' | 'name_candidate_exact' | 'name_candidate_partial';

const MATCH_MEANING: Record<MatchType, string> = {
  npi_match: 'The NPI matched exactly. An NPI identifies one provider, so this is an identification.',
  license_match: 'The license/registration number matched exactly. A license number identifies one provider, so this is an identification.',
  name_candidate_exact: 'The full name matched exactly, but this list has no date of birth or address to confirm it is the same person — several excluded providers can share a name. Confirm with NPI or license number before acting.',
  name_candidate_partial: 'The name is a partial/substring match, not exact. Treat as a lead to check, not a finding. Confirm with NPI or license number.',
};

function shape(r: NyOmigRow, matchType: MatchType) {
  return {
    provider_name: r.provider_name,
    license_number: r.license_number,
    npi: r.npi,
    provider_type: r.provider_type,
    excluded_since: r.excluded_since,
    match_type: matchType,
    what_that_means: MATCH_MEANING[matchType],
  };
}

async function checkExclusion(args: Record<string, unknown>) {
  const nameRaw = typeof args.name === 'string' ? args.name.trim() : '';
  const npiRaw = typeof args.npi === 'string' ? digitsOnly(args.npi) : '';
  const licenseRaw = typeof args.license === 'string' ? args.license.trim() : '';
  const licenseDigits = licenseRaw ? digitsOnly(licenseRaw) : '';

  if (!nameRaw && !npiRaw && !licenseRaw) {
    return {
      found: false,
      reason: 'no_query',
      hint: 'Pass name (the provider or business to screen), and/or npi, and/or license. An NPI or license match is an identification; a name match is a lead.',
      source: SOURCE_LABEL,
      source_url: SOURCE_URL,
      data_as_of: DATA_AS_OF,
    };
  }

  const limit = Math.max(1, Math.min(50, Math.floor(typeof args.limit === 'number' ? args.limit : 10)));

  // Identity-grade matches first: NPI, then license number — both exact.
  const npiMatches = npiRaw ? ROWS.filter((r) => r.npi && digitsOnly(r.npi) === npiRaw) : [];
  const licenseMatches = licenseDigits
    ? ROWS.filter((r) => r.license_number && digitsOnly(r.license_number).replace(/^0+/, '') === licenseDigits.replace(/^0+/, '') && digitsOnly(r.license_number).length > 0)
    : [];

  const identitySeen = new Set<NyOmigRow>();
  const identityResults: ReturnType<typeof shape>[] = [];
  for (const r of npiMatches) {
    if (identitySeen.has(r)) continue;
    identitySeen.add(r);
    identityResults.push(shape(r, 'npi_match'));
  }
  for (const r of licenseMatches) {
    if (identitySeen.has(r)) continue;
    identitySeen.add(r);
    identityResults.push(shape(r, 'license_match'));
  }

  // Name-candidate matches: exact normalized name, then token-substring.
  let nameResults: ReturnType<typeof shape>[] = [];
  if (nameRaw) {
    const qNorm = normalize(nameRaw);
    const qTokens = qNorm.split(' ').filter(Boolean);
    const exact: ReturnType<typeof shape>[] = [];
    const partial: ReturnType<typeof shape>[] = [];
    for (const r of ROWS) {
      if (identitySeen.has(r)) continue; // already reported as an identity match
      const nNorm = normalize(r.provider_name);
      if (nNorm === qNorm) {
        exact.push(shape(r, 'name_candidate_exact'));
      } else if (qTokens.length > 0 && qTokens.every((t) => nNorm.includes(t))) {
        partial.push(shape(r, 'name_candidate_partial'));
      }
    }
    nameResults = [...exact, ...partial];
  }

  const combined = [...identityResults, ...nameResults];
  const truncated = combined.length > limit;
  const matches = combined.slice(0, limit);

  if (matches.length === 0) {
    return {
      found: false,
      result: 'No match found in the NY OMIG Medicaid exclusion list for that provider.',
      screened: { name: nameRaw || null, npi: npiRaw || null, license: licenseRaw || null },
      caveat: `This checks the NY OMIG exclusion list only. It does not cover the federal HHS OIG LEIE, the federal SAM exclusions list, or any other state's Medicaid exclusion list. ${NO_REASON_CAVEAT}`,
      source: SOURCE_LABEL,
      source_url: SOURCE_URL,
      data_as_of: DATA_AS_OF,
    };
  }

  return {
    found: true,
    screened: { name: nameRaw || null, npi: npiRaw || null, license: licenseRaw || null },
    count: matches.length,
    truncated,
    matches,
    not_an_identification: NOT_AN_ANSWER,
    no_reason_data: NO_REASON_CAVEAT,
    source: SOURCE_LABEL,
    source_url: SOURCE_URL,
    data_as_of: DATA_AS_OF,
  };
}

async function coverage() {
  const withNpi = ROWS.filter((r) => r.npi).length;
  const withLicense = ROWS.filter((r) => r.license_number).length;
  const dates = ROWS.map((r) => r.excluded_since).filter((d): d is string => Boolean(d)).sort();
  const providerTypes = new Set(ROWS.map((r) => r.provider_type).filter(Boolean));

  return {
    found: true,
    total_exclusions: TOTAL_ROWS,
    with_npi: withNpi,
    with_license_number: withLicense,
    distinct_provider_types: providerTypes.size,
    oldest_exclusion_date: dates[0] ?? null,
    newest_exclusion_date: dates[dates.length - 1] ?? null,
    data_as_of: DATA_AS_OF,
    index_captured_at: CAPTURED_AT,
    note: NO_REASON_CAVEAT,
    online_search_url: SEARCH_URL,
    source: SOURCE_LABEL,
    source_url: SOURCE_URL,
  };
}

const tools: McpToolExport['tools'] = [
  {
    name: 'ny_omig_check_exclusion',
    description:
      'Is this healthcare provider barred from New York State\'s Medicaid program? Screens a person or business name, an NPI, and/or a professional license number against the NY Office of the Medicaid Inspector General (OMIG) Medicaid exclusion list — the state-level counterpart to the federal HHS OIG LEIE (see the leie pack) for New York specifically. Answers "is this provider excluded from NY Medicaid", "check this NPI against the OMIG exclusion list", or pre-payment/credentialing screening for a NY Medicaid provider. '
      + 'An NPI or license-number match is an IDENTIFICATION (both are exact, provider-specific identifiers); a name match — even an exact one — is a CANDIDATE lead only, since this list carries no date of birth or address to tell same-named providers apart. Returns provider type and exclusion effective date for every match; OMIG\'s published data does not include an exclusion reason or statutory authority (unlike the federal LEIE), and the response says so. Pass npi or license to turn a name lead into an identification. Sourced from NY OMIG, keyless.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        name: { type: 'string', description: 'Provider or business name to screen, e.g. "John Smith" or "Acme Pharmacy Corp". Any word order.' },
        npi: { type: 'string', description: 'The provider\'s 10-digit NPI, if known. An NPI match is an identification rather than a name lead — always pass it when known.' },
        license: { type: 'string', description: 'NY professional license/registration number, if known (e.g. pharmacy or physician license). A license match is an identification.' },
        limit: { type: 'number', description: 'Maximum matches to return (default 10, max 50).' },
      },
    },
  },
  {
    name: 'ny_omig_exclusion_coverage',
    description:
      'What the NY OMIG Medicaid exclusion data covers and how current it is: total exclusions held, how many carry an NPI or license number, how many distinct provider types appear, the oldest and newest exclusion dates, and OMIG\'s own "data last updated" date for the copy this pack serves. Use to check the screening data is fresh enough to rely on before a compliance decision, and to see the one-line note on what OMIG does NOT publish (exclusion reason/authority). Sourced from NY OMIG, keyless.',
    inputSchema: { type: 'object' as const, properties: {} },
  },
];

async function callTool(name: string, args: Record<string, unknown>): Promise<unknown> {
  ensureIndex(args);
  switch (name) {
    case 'ny_omig_check_exclusion':
      return checkExclusion(args);
    case 'ny_omig_exclusion_coverage':
      return coverage();
    default:
      throw new Error(`Unknown tool: ${name}`);
  }
}

export { tools, callTool };
export default { tools, callTool, meter: { credits: 1 } } satisfies McpToolExport;
