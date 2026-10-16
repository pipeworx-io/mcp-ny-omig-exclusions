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
 * Shared "count records by a named date field over a year or range" helper —
 * fleet #3170.
 *
 * WHY THIS EXISTS. Four baked-table packs (ny-omig-exclusions,
 * tx-medical-exclusions, ca-medical-exclusions, fl-medical-exclusions) each
 * hold thousands of rows and each had only a list-wide total — no way to
 * answer "how many took effect in year Y" without a caller paging through
 * every row itself. A benchmark probe (fleet #3170/#3149) asked exactly that
 * question against two of them and both returned the SAME list-wide total on
 * every one of 7-8 rounds; the model ran out of rounds and refused rather
 * than get a wrong number. This is the one piece of that fix every pack
 * shares: parsing `year` or `start_date`/`end_date` into an inclusive
 * YYYY-MM-DD range, or a NAMED reason when the input can't be turned into
 * one. It deliberately never returns a silent zero for a bad argument —
 * root CLAUDE.md's silent-zero policy applies to a malformed count request
 * exactly as it does to an upstream outage.
 *
 * WHAT IT DOES NOT DO. It does not touch the rows — each pack's own ISO date
 * field (already YYYY-MM-DD in every one of these four) is filtered by plain
 * string comparison, which is correct for YYYY-MM-DD strings and avoids a
 * Date() parse / timezone trap entirely. Each pack is responsible for saying
 * which of its own fields it counted (data varies: NY/TX/CA have exactly one
 * exclusion-date field each; FL additionally splits "all sanction orders" vs
 * "participation exclusions" within the matched range).
 */

interface DateRange {
  /** Inclusive start date, YYYY-MM-DD. */
  start: string;
  /** Inclusive end date, YYYY-MM-DD. */
  end: string;
  /** Human label for the range, e.g. "2025" or "2024-06-01 to 2025-06-01". */
  label: string;
}

interface DateRangeError {
  error: string;
}

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

/**
 * Reads `args.year`, `args.start_date` and `args.end_date` and returns:
 *   - `null` if none were passed (no date-range count was requested at all —
 *     the caller should fall through to its normal, non-counting response);
 *   - `{ error }` if something WAS passed but can't be turned into a valid
 *     range (bad format, start after end, year out of a sane bound) — the
 *     caller must surface this as a named reason, never as a zero count;
 *   - `{ start, end, label }` otherwise.
 *
 * start_date/end_date, if either is present, take precedence over `year`
 * (an explicit range is a more specific request than a calendar year).
 */
function parseYearOrDateRange(args: Record<string, unknown>): DateRange | DateRangeError | null {
  const startRaw = typeof args.start_date === 'string' ? args.start_date.trim() : '';
  const endRaw = typeof args.end_date === 'string' ? args.end_date.trim() : '';
  const yearRaw = args.year;
  const yearGiven = yearRaw !== undefined && yearRaw !== null && yearRaw !== '';

  if (!startRaw && !endRaw && !yearGiven) return null;

  if (startRaw || endRaw) {
    if (!DATE_RE.test(startRaw) || !DATE_RE.test(endRaw)) {
      return {
        error:
          `start_date and end_date must BOTH be present and in YYYY-MM-DD form ` +
          `(got start_date=${startRaw ? JSON.stringify(startRaw) : '(missing)'}, end_date=${endRaw ? JSON.stringify(endRaw) : '(missing)'}).`,
      };
    }
    if (startRaw > endRaw) {
      return { error: `start_date (${startRaw}) is after end_date (${endRaw}).` };
    }
    return { start: startRaw, end: endRaw, label: startRaw === endRaw ? startRaw : `${startRaw} to ${endRaw}` };
  }

  const year = Math.floor(Number(yearRaw));
  if (!Number.isFinite(year) || year < 1900 || year > 2100) {
    return { error: `year must be a 4-digit calendar year between 1900 and 2100 (got ${JSON.stringify(yearRaw)}).` };
  }
  return { start: `${year}-01-01`, end: `${year}-12-31`, label: String(year) };
}

function isDateRangeError(r: DateRange | DateRangeError | null): r is DateRangeError {
  return r != null && typeof (r as DateRangeError).error === 'string';
}

/** Inclusive YYYY-MM-DD membership test; `null`/empty dates never match. */
function inRange(date: string | null | undefined, range: DateRange): boolean {
  return Boolean(date) && (date as string) >= range.start && (date as string) <= range.end;
}

const DATE_RANGE_ARG_SCHEMA = {
  year: {
    type: 'number' as const,
    description: 'Count records whose date field falls in this calendar year (e.g. 2025), counted over the WHOLE list, not a page. Ignored if start_date/end_date are given.',
  },
  start_date: {
    type: 'string' as const,
    description: 'Inclusive range start, YYYY-MM-DD. Use with end_date for a custom date range instead of a calendar year.',
  },
  end_date: {
    type: 'string' as const,
    description: 'Inclusive range end, YYYY-MM-DD. Use with start_date for a custom date range instead of a calendar year.',
  },
};
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

async function coverage(args: Record<string, unknown>) {
  const withNpi = ROWS.filter((r) => r.npi).length;
  const withLicense = ROWS.filter((r) => r.license_number).length;
  const dates = ROWS.map((r) => r.excluded_since).filter((d): d is string => Boolean(d)).sort();
  const providerTypes = new Set(ROWS.map((r) => r.provider_type).filter(Boolean));

  // fleet #3170: count-by-date-range mode. A benchmark probe found this tool
  // returned the SAME list-wide total on every call when asked "how many
  // exclusions took effect in 2025" — the model ran out of rounds with no
  // way to get a real number. When year/start_date/end_date is passed,
  // return the count FIRST (before any of the plain coverage fields below)
  // and say plainly which date field was counted and over what range.
  const range = parseYearOrDateRange(args);
  if (isDateRangeError(range)) {
    return {
      found: false,
      reason: 'invalid_date_range',
      hint: range.error,
      source: SOURCE_LABEL,
      source_url: SOURCE_URL,
      data_as_of: DATA_AS_OF,
    };
  }
  if (range) {
    const count = ROWS.filter((r) => inRange(r.excluded_since, range)).length;
    return {
      found: true,
      mode: 'date_range_count',
      count,
      date_field_counted: 'excluded_since — OMIG\'s published exclusion effective date',
      range: { start: range.start, end: range.end, label: range.label },
      counted_over: 'the whole list (9,000+ rows), not a page',
      total_exclusions_all_time: TOTAL_ROWS,
      oldest_exclusion_date: dates[0] ?? null,
      newest_exclusion_date: dates[dates.length - 1] ?? null,
      data_as_of: DATA_AS_OF,
      index_captured_at: CAPTURED_AT,
      note: NO_REASON_CAVEAT,
      source: SOURCE_LABEL,
      source_url: SOURCE_URL,
    };
  }

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
      'What the NY OMIG Medicaid exclusion data covers and how current it is: total exclusions held, how many carry an NPI or license number, how many distinct provider types appear, the oldest and newest exclusion dates, and OMIG\'s own "data last updated" date for the copy this pack serves. Use to check the screening data is fresh enough to rely on before a compliance decision, and to see the one-line note on what OMIG does NOT publish (exclusion reason/authority). '
      + 'Pass year (e.g. 2025) or start_date/end_date to instead COUNT how many exclusions have an effective date in that year or range, counted over the whole ~9,100-row list, not a page — answers "how many NY OMIG exclusions took effect in 2025". The response names the date field counted (excluded_since, OMIG\'s exclusion effective date). Sourced from NY OMIG, keyless.',
    inputSchema: { type: 'object' as const, properties: { ...DATE_RANGE_ARG_SCHEMA } },
  },
];

async function callTool(name: string, args: Record<string, unknown>): Promise<unknown> {
  ensureIndex(args);
  switch (name) {
    case 'ny_omig_check_exclusion':
      return checkExclusion(args);
    case 'ny_omig_exclusion_coverage':
      return coverage(args);
    default:
      throw new Error(`Unknown tool: ${name}`);
  }
}

export { tools, callTool };
export default { tools, callTool, meter: { credits: 1 } } satisfies McpToolExport;
