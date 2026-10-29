import { HttpApi, HttpApiEndpoint, HttpApiGroup, HttpApiSchema, OpenApi } from 'effect/http-api';
import { API_VERSION, MAX_BODY_BYTES } from '../config.ts';
import { AmbiguousTicker, MAX_ISSUES, RateNotAvailable, UnknownTicker } from './errors.ts';
import { DataVersion, EntryLimit, JsonBody, RateLimit, RequestValidation } from './middleware.ts';
import {
  CalculationResponseSchema,
  CompanyDetailSchema,
  CompanyListSchema,
  HealthSchema,
  MAX_ENTRIES_PER_REQUEST,
  MetaSchema,
  RateParams,
  RateSchema,
  TickerParams,
  calculationRequestSchema,
  type Coverage,
} from './schemas.ts';

const METHODOLOGY_URL = 'https://trynaqua.com/methodology';

// The document shows path parameters in their encoded form, a string, which
// drops the annotations on their schemas. Describe them on the parameters.
const PATH_PARAMETERS: Record<string, { description: string; example: string }> = {
  ticker: { description: 'Tadawul ticker of the company.', example: '2330' },
  year: { description: 'Financial year of the rate. `GET /v1/meta` lists the years in `coverage.years`.', example: '2023' },
};

type Operation = { parameters?: { name: string; in: string }[] };

const describePathParameters = (spec: Record<string, unknown>) => {
  for (const operations of Object.values(spec['paths'] as Record<string, Record<string, Operation>>)) {
    for (const operation of Object.values(operations)) {
      for (const parameter of operation.parameters ?? []) {
        if (parameter.in === 'path') Object.assign(parameter, PATH_PARAMETERS[parameter.name]);
      }
    }
  }
  return spec;
};
const methodologyDocs = { url: METHODOLOGY_URL, description: 'Al-Maqased methodology, as published on trynaqua.com (Arabic)' };

const companies = HttpApiGroup.make('companies')
  .add(
    HttpApiEndpoint.get('list', '/v1/companies', { success: CompanyListSchema }).annotateMerge(
      OpenApi.annotations({
        summary: 'List companies',
        description:
          'Returns every company in one response, sorted by ticker, with the years that have a published rate. ' +
          'There is no pagination. Use it for a company search or a ticker picker, and cache it until `X-Data-Version` ' +
          'changes.\n\n' +
          '`overallStatus` is a summary for lists only. To screen a company for a given year, use that year\'s `status`.',
      }),
    ),
    HttpApiEndpoint.get('detail', '/v1/companies/:ticker', {
      params: TickerParams,
      success: CompanyDetailSchema,
      error: [UnknownTicker, AmbiguousTicker],
    })
      .middleware(RequestValidation)
      .annotateMerge(
        OpenApi.annotations({
          summary: 'Retrieve a company',
          description:
            'Returns the company and every year the data covers for it, each with its Sharia classification (`status`) ' +
            'and purification rate (`ratePerShare`). Use it to show a company\'s history.\n\n' +
            'A year can have a status but no rate (`ratePerShare: null`), or a rate but no status (`status: null`). ' +
            'A year with neither is left out.',
        }),
      ),
    HttpApiEndpoint.get('rate', '/v1/companies/:ticker/rates/:year', {
      params: RateParams,
      success: RateSchema,
      error: [UnknownTicker, RateNotAvailable, AmbiguousTicker],
    })
      .middleware(RequestValidation)
      .annotateMerge(
        OpenApi.annotations({
          summary: 'Retrieve a yearly rate',
          description:
            'Returns one year\'s purification rate and Sharia classification. Use it to screen a company for a ' +
            'specific year.\n\n' +
            'If no rate is published for that year, the response is `404 RATE_NOT_AVAILABLE`, even when the year has ' +
            'a known status. `GET /v1/companies/{ticker}` shows that status.',
        }),
      ),
  )
  .annotateMerge(
    OpenApi.annotations({
      title: 'Companies',
      description:
        'Saudi listed companies, by Tadawul ticker, with each year\'s Sharia classification (`status`) and ' +
        'purification rate (`ratePerShare`, SAR per share for a full year). Names are in Arabic. The classifications ' +
        'and rates are published by the Al-Maqased Center; see the introduction for what each value means.',
      externalDocs: methodologyDocs,
    }),
  );

const purification = (coverage: Coverage) =>
  HttpApiGroup.make('purification')
    .add(
      HttpApiEndpoint.post('calculate', '/v1/purification/calculate', {
        payload: calculationRequestSchema(coverage),
        success: CalculationResponseSchema,
        error: [UnknownTicker, AmbiguousTicker, RateNotAvailable.pipe(HttpApiSchema.status(422))],
      })
        .middleware(RequestValidation)
        .middleware(EntryLimit)
        .middleware(JsonBody)
        .annotateMerge(
          OpenApi.annotations({
            summary: 'Calculate purification',
            description:
              `Calculates the amount to purify, in SAR, for 1 to ${MAX_ENTRIES_PER_REQUEST} holdings in one request. ` +
              'Give each holding one of two modes:\n\n' +
              `- **Date mode:** \`purchaseDate\`, with \`saleDate\` or \`stillOwned: true\`. Dates run from ` +
              `${coverage.startIso} to ${coverage.endIso}.\n` +
              `- **Days mode:** \`year\` (${coverage.firstYear}–${coverage.lastYear}) with \`daysOwned\`, when you ` +
              'know how long the shares were held but not the dates.\n\n' +
              'Each holding is split into calendar years, and each year is prorated: ' +
              '`shares × ratePerShare × daysOwned / 365`. The response breaks the amount down by holding and by year.\n\n' +
              'The request is all-or-nothing. If any entry cannot be calculated, nothing is returned, and ' +
              '`details.entryIndex` names the entry. A year without a published rate fails with `422 RATE_NOT_AVAILABLE`.',
          }),
        ),
    )
    .annotateMerge(
      OpenApi.annotations({
        title: 'Purification',
        description:
          'The amount to purify for a set of holdings, calculated from the published yearly rates with the same ' +
          'arithmetic as the calculator on trynaqua.com. The introduction explains the formula and its rules.',
        externalDocs: methodologyDocs,
      }),
    );

const meta = HttpApiGroup.make('meta')
  .add(
    HttpApiEndpoint.get('meta', '/v1/meta', { success: MetaSchema }).annotateMerge(
      OpenApi.annotations({
        summary: 'Retrieve metadata',
        description:
          'Returns the dates and years the data covers, the data version, the unit and formula, the number of ' +
          'companies, the tickers that cannot be resolved, and the request limits. Read it at startup, and again ' +
          'when `X-Data-Version` changes.',
      }),
    ),
  )
  .annotateMerge(
    OpenApi.annotations({ title: 'Meta', description: 'What the data covers, which version is live, and the limits.' }),
  );

const health = HttpApiGroup.make('health')
  .add(
    HttpApiEndpoint.get('health', '/health', { success: HealthSchema }).annotateMerge(
      OpenApi.annotations({
        summary: 'Check health',
        description: 'Returns `{ "status": "ok" }` while the service is up. It has no rate limit, so use it for uptime monitoring.',
      }),
    ),
  )
  .annotate(OpenApi.Title, 'Health');

// The introduction on the docs page. Sharia rules in it come only from the
// methodology page, cited by paragraph (§); everything else is API behaviour.
const introduction = ({
  coverage,
  requestsPerMinute,
  publicUrl,
}: {
  coverage: Coverage;
  requestsPerMinute: number;
  publicUrl: string;
}) => `The Naqua API gives you the Sharia classification and the purification rate of Saudi listed companies (Tadawul), year by year, and calculates how much to purify for a set of holdings. Use it to add Sharia screening and purification to a portfolio tracker, a brokerage or banking app, an investment dashboard, or a personal finance tool.

- **No key and no sign-up.** Requests and responses are JSON, and any website can call the API from the browser.
- **The same numbers as trynaqua.com.** The API runs the calculation of the [trynaqua.com](https://trynaqua.com) calculator, and tests hold the two to the same results.
- **Stable errors.** Every error has a fixed \`code\` and a message in Arabic and English.

The data covers ${coverage.startIso} to ${coverage.endIso}. The base URL is \`${publicUrl}\`, and the OpenAPI 3.1 document is at [\`/openapi.json\`](${publicUrl}/openapi.json).

| To | Call |
| --- | --- |
| Screen a company for a year | \`GET /v1/companies/{ticker}/rates/{year}\` |
| Show a company's history | \`GET /v1/companies/{ticker}\` |
| Build a company search or ticker picker | \`GET /v1/companies\` |
| Calculate purification for a portfolio | \`POST /v1/purification/calculate\` |
| Check coverage, data version and limits | \`GET /v1/meta\` |

## Quickstart

**1. Get a company's rate for a year.**

\`\`\`bash
curl ${publicUrl}/v1/companies/2330/rates/2023
\`\`\`

\`\`\`json
{
  "ticker": 2330,
  "name": "المتقدمة",
  "year": 2023,
  "ratePerShare": 0.0203,
  "status": "pure"
}
\`\`\`

\`status\` is the Sharia classification for that year. \`ratePerShare\` is the SAR to purify for each share held for the whole year. It is not a percentage.

**2. Calculate the amount for your holdings.** Give each holding either dates or a number of days:

\`\`\`bash
curl -s ${publicUrl}/v1/purification/calculate \\
  -H 'Content-Type: application/json' \\
  -d '{"entries":[
        {"ticker":2330,"shares":100,"purchaseDate":"2021-03-01","saleDate":"2023-06-30"},
        {"ticker":2222,"shares":10,"purchaseDate":"2023-01-01","stillOwned":true},
        {"ticker":2001,"shares":50,"year":2022,"daysOwned":200}
      ]}'
\`\`\`

The response has \`totalPurificationAmount\` in SAR, and a breakdown by holding and by calendar year.

**3. Show the result.** Show the amount with its currency and the years it covers, and link to the [methodology](${METHODOLOGY_URL}). We recommend a small attribution line near the data, such as in the footer of a result card:

\`\`\`html
<a href="https://trynaqua.com">بيانات التطهير عبر نقوة</a>
\`\`\`

The Attribution section below has the details.

## Where the data comes from

Naqua provides this API. The classifications and rates are published by the [Al-Maqased Center for Economic Consultations](https://almaqased.net) (مركز المقاصد للاستشارات الاقتصادية), whose methodology is published at [trynaqua.com/methodology](${METHODOLOGY_URL}). Everything these docs say about Sharia rules comes from that page and cites its paragraphs (§). Where the API makes a technical choice of its own, these docs say so.

- Each \`year\` is the financial year of the audited annual statements behind the rate. For example, the 2025 rates come from Al-Maqased's 2026 report on the 2025 statements.

## Sharia classification

\`status\` is set for each year, because a company's classification can change. The methodology defines these categories (§14, §18):

| \`status\` | Category | Definition |
| --- | --- | --- |
| \`pure\` | الشركة النقية | Its activity is permissible, and its financial statements show no impermissible investments or financing. This does not mean it is free of every fault: matters the statements do not disclose may still call for some purification. |
| \`mixed\` | الشركة المختلطة | Its activity is permissible, but it borrowed in an impermissible way or made impermissible investments, or both, at no more than one third of total assets, and its impermissible revenue is no more than 5% of total revenue. |
| \`non-pure\` | الشركة غير المتوافقة | Its activity is permissible, but its impermissible borrowing or investment is more than one third of total assets, or its impermissible revenue is more than 5% of total revenue. |
| \`public-sector\` | شركات القطاع العام | A company owned by the public treasury (بيت المال), such as Saudi Aramco. The §14 criteria do not apply to these companies. For Aramco, the methodology holds that subscribing to, trading and investing in its shares is permissible without those criteria, and that what must be purified is purified as a precaution. |
| \`null\` | | The data gives no status for that year. |

- The methodology also defines a company whose main activity is impermissible (الشركة محرمة النشاط), such as a conventional commercial bank. The API has no separate value for it.
- **Scope (§1).** The study covers joint-stock companies and traded real-estate funds on the Saudi Main Market and Nomu, except banks that have their own Sharia boards.
- **Listed companies only (§16).** For the scholars who hold them, these classification rules are a concession (رخصة) specific to listed joint-stock companies. They do not apply to unlisted companies.
- **\`overallStatus\`** is computed by the API, and is not a methodology category. It is the status when every year with a known status agrees, and \`varies\` when they differ.

## Purification rates

\`ratePerShare\` is the SAR to purify for each share held for a full year. Zero is a real rate. \`null\` means no rate was published.

The methodology computes it from the companies' audited annual statements (§22):

| Item | Amount purified |
| --- | --- |
| Income that is certainly or most likely impermissible: late-payment penalties on debts, earned commissions, revenue and interest, commission income from time deposits, and interest on current or savings accounts | The full amount |
| Revenue under "other" that is not disclosed, Saudi and non-Saudi equity portfolios, and derivative gains | 0.25% |
| Impermissible investments, such as bonds, conventional deposits and investments in impermissible activities | 1% of their value |
| Current-account balances | Half the prevailing interest rate |

When a company reports the returns on conventional and Islamic deposits as one amount without the split, half (50%) of it is counted as impermissible revenue (§12). The total is divided by the number of the company's shares, from the latest published annual statements (§23).

**Classification and rate are separate (§15).** The classification rests on activity, financing and investment, and purification rests on income and investment. A company can be \`mixed\` because it borrowed at interest, which brings it no impermissible income, so its rate can be zero or close to it. A \`pure\` company can still have a rate above zero (§14), as 2330 does in 2023.

**Paying it out (§24).** Scholars stress that the amount is given to charitable causes with the intention of ridding oneself of it. It is not zakat or sadaqah, and the person purifying may not benefit from it.

## How the API calculates

The methodology's formula, for holdings not owned for a full year (§23):

\`\`\`
purificationAmount = shares × ratePerShare × daysOwned / 365
\`\`\`

The rules below are the API's technical choices, which match the trynaqua.com calculator:

- A holding is split into calendar years. Each year uses that year's rate and status.
- **Date mode** does not count the sale day. A full calendar year is 365 days, or 366 in a leap year, and the divisor is always 365.
- **\`stillOwned\`** runs until \`coverage.end\` (${coverage.endIso}), not until today, and that day is not counted either.
- **Days mode** cuts \`daysOwned\` into consecutive 365-day years, starting from \`year\`. It does not count leap days.
- Amounts are in SAR, rounded to 10 decimal places. \`totalPurificationAmount\` sums every yearly amount, not the subtotal of each holding.
- **The API stops at \`coverage.end\`.** It does not apply a rate to days after it, and rejects dates after it. The methodology says the latest per-share amount is the only information available, and is enough for the past and the current year (§23). If your product applies it to later days, do that in your own code, and tell your users.

## Limitations

- **Information, not a ruling.** The rates and amounts are for information only. They are not a fatwa or financial advice. Al-Maqased states that its work is not commercial, and is not an advertisement for securities or an invitation to deal in them (§25).
- **Disclosure.** The methodology relies only on what the annual statements say and the external auditor has reviewed and approved (§4). Disclosure varies widely between companies, so the methodology decides by the most likely judgment (غلبة الظن), with caution, especially in purification (§6).
- **Methodology editions.** The methodology page reproduces the 2026 edition, from the report on the 2025 statements, which notes small changes from the previous edition. The rates for earlier years come from earlier reports.
- **Gaps.** A year can have a status but no rate, or a rate but no status. The data ends at ${coverage.endIso}.
- **Unresolved tickers.** When the source gives one ticker to more than one company, the API answers \`409 AMBIGUOUS_TICKER\` until it is resolved. \`GET /v1/meta\` lists these tickers in \`unresolvedTickers\`.

## Integration guide

- **Batch.** Send up to ${MAX_ENTRIES_PER_REQUEST} holdings in one calculation. It counts as one request.
- **Rate limit.** Each IP address can make ${requestsPerMinute} requests per minute to \`/v1\`. Every \`/v1\` response, including an error, carries \`RateLimit-Limit\`, \`RateLimit-Remaining\` and \`RateLimit-Reset\` (seconds). A \`429\` also carries \`Retry-After\`, in seconds.
- **Caching.** The data changes only with a new release. A successful \`GET\` carries \`Cache-Control: public, max-age=3600\`, and every \`/v1\` response carries \`X-Data-Version\`. When the version changes, refresh what you cached.
- **Errors.** Branch on \`error.code\`, never on the message text. Show \`error.message.ar\` or \`error.message.en\` to your users.
- **Requests.** Send \`Content-Type: application/json\`, with a body of at most ${MAX_BODY_BYTES / 1024} KiB.
- **Monitoring.** \`GET /health\` has no rate limit.

## Errors

Every error has the same shape:

\`\`\`json
{
  "error": {
    "code": "RATE_NOT_AVAILABLE",
    "message": { "ar": "نسبة التطهير لشركة المتقدمة في السنة 2030 غير متوفرة.", "en": "No purification rate is published for المتقدمة in 2030." },
    "details": { "ticker": 2330, "year": 2030 }
  }
}
\`\`\`

| \`code\` | Status | Meaning | \`details\` | What to do |
| --- | --- | --- | --- | --- |
| \`VALIDATION_ERROR\` | 400 | The request is invalid. | Up to ${MAX_ISSUES} \`{ path, message }\` items. Absent when the body is not valid JSON. | Fix the named fields. |
| \`UNKNOWN_TICKER\` | 404 | No company with this ticker is in the data. | \`ticker\`, \`entryIndex\`? | Check the ticker. This says nothing about the company's classification. |
| \`RATE_NOT_AVAILABLE\` | 404 on a lookup, 422 in a calculation | No rate is published for that company and year. | \`ticker\`, \`year\`, \`entryIndex\`? | Show that no rate is available. Do not use zero or another year's rate. |
| \`AMBIGUOUS_TICKER\` | 409 | The source gives this ticker to more than one company. | \`ticker\`, \`candidates\` (names), \`entryIndex\`? | Leave the holding out, or tell your user it cannot be resolved yet. |
| \`PAYLOAD_TOO_LARGE\` | 413 | The body is over ${MAX_BODY_BYTES / 1024} KiB. | | Split the request. |
| \`RATE_LIMITED\` | 429 | Too many requests. | | Wait for \`Retry-After\` seconds. |
| \`NOT_FOUND\` | 404 | No such route. | | Check the method and path. |
| \`INTERNAL_ERROR\` | 500 | An unexpected error. | | Retry later. |

\`entryIndex\` appears only on calculation errors, and it is the position of the failing entry in \`entries\`.

## For AI agents

If you are an AI agent or coding assistant that uses or integrates this API, follow these rules. They prevent the most common misreadings of the data.

1. **\`ratePerShare\` is SAR per share for a full year.** It is not a percentage, and you do not multiply it by the share price.
2. **Use \`POST /v1/purification/calculate\` for amounts.** Do not rewrite the arithmetic: the endpoint handles the year splits, leap years and rounding.
3. **\`null\` is not zero.** A \`null\` rate, or \`RATE_NOT_AVAILABLE\`, means no rate was published. Never fill the gap with zero, another year's rate or an estimate.
4. **Do not infer the rate from the status, or the status from the rate (§15).** A \`pure\` year can have a rate above zero, and a \`mixed\` year can have a rate of zero.
5. **Classification is per year.** For a given year, read that year's \`status\`. \`overallStatus\` is a summary, and \`varies\` is not a category.
6. **Use the categories as defined.** Describe a \`status\` with its methodology category and definition from these docs. Do not turn it into a ruling of your own.
7. **An unknown ticker is not a classification.** \`UNKNOWN_TICKER\` means only that the company is not in the data.
8. **Respect the coverage.** Read \`coverage\` from \`GET /v1/meta\`. Do not quietly calculate days after \`coverage.end\`.
9. **Present results as information.** They are not a fatwa or financial advice. Link to the [methodology](${METHODOLOGY_URL}) where users see the data.
10. **Keep the provider and the source apart.** Naqua provides the API. The Al-Maqased Center publishes the classifications and rates.
11. **Add the attribution line** when you build an interface that shows this data (see below).

## Attribution

When your product shows data from this API, we recommend a short line near it:

\`\`\`html
<a href="https://trynaqua.com">بيانات التطهير عبر نقوة</a>
\`\`\`

Keep it subtle, in small secondary text: under a result card or a table, in a tooltip, or in the footer of the screen. The line credits Naqua as the provider of the API. The classifications and rates themselves are published by the Al-Maqased Center, so name the center wherever you describe where the numbers come from. This is a recommended practice, not a condition of use, and the API does not check for it.`;

export const makeApi = ({
  coverage,
  requestsPerMinute,
  publicUrl,
}: {
  coverage: Coverage;
  requestsPerMinute: number;
  publicUrl: string;
}) =>
  HttpApi.make('naqua')
    .add(companies, purification(coverage), meta)
    // Only the groups added so far, the ones under /v1. The last one added runs first.
    .middleware(RateLimit)
    .middleware(DataVersion)
    .add(health)
    .annotate(HttpApi.ParseOptions, { errors: 'all' })
    .annotateMerge(
      OpenApi.annotations({
        title: 'Naqua Purification API',
        version: API_VERSION,
        description: introduction({ coverage, requestsPerMinute, publicUrl }),
        servers: [{ url: publicUrl }],
        transform: describePathParameters,
      }),
    );

export type Api = ReturnType<typeof makeApi>;
