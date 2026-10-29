import { Schema } from 'effect';
import type { LoadedDataset } from '../data/dataset.ts';
import { STATUSES } from '../data/schema.ts';
import { parseIsoDate } from '../domain/dates.ts';

export const MAX_ENTRIES_PER_REQUEST = 100;


export const StatusSchema = Schema.NullOr(Schema.Literals(STATUSES)).annotate({
  identifier: 'Status',
  description:
    'Sharia classification for the year, as the methodology defines it (§14, §18): `pure` (الشركة النقية), ' +
    '`mixed` (الشركة المختلطة), `non-pure` (الشركة غير المتوافقة), or `public-sector` (شركات القطاع العام, to which ' +
    'the §14 criteria do not apply). `null` when the data gives no status. It does not determine the rate (§15).',
});

const PositiveIntSchema = Schema.Int.check(Schema.isGreaterThan(0));

export const TickerParams = { ticker: PositiveIntSchema.annotate({ examples: [2330] }) };
export const RateParams = { ...TickerParams, year: Schema.Int.annotate({ examples: [2023] }) };


const companyFields = {
  ticker: Schema.Int.annotate({ examples: [2330], description: 'Tadawul ticker.' }),
  name: Schema.String.annotate({ examples: ['المتقدمة'], description: 'Arabic name.' }),
  aliases: Schema.Array(Schema.String).annotate({ examples: [[]], description: 'Former or alternative Arabic names.' }),
  overallStatus: Schema.NullOr(Schema.Literals([...STATUSES, 'varies'])).annotate({
    description:
      'A summary computed by the API, not a methodology category: the status when every year with a known status ' +
      'has the same one, `varies` when they differ, and `null` when no year has a status. Use the yearly `status` ' +
      'for a given year.',
  }),
};

export const CompanySummarySchema = Schema.Struct({
  ...companyFields,
  availableYears: Schema.Array(Schema.Int).annotate({
    examples: [[2022, 2023, 2024]],
    description: 'Years with a published rate, in ascending order. Other years may still have a status.',
  }),
}).annotate({ identifier: 'CompanySummary' });

export const CompanyListSchema = Schema.Struct({
  count: Schema.Int.annotate({ description: 'Number of companies in `companies`.' }),
  companies: Schema.Array(CompanySummarySchema),
}).annotate({ identifier: 'CompanyList', description: 'Every company, sorted by ticker, with the years that have a rate.' });

export const CompanyYearSchema = Schema.Struct({
  year: Schema.Int.annotate({ examples: [2023], description: 'Financial year of the annual statements.' }),
  ratePerShare: Schema.NullOr(Schema.Number).annotate({
    examples: [0.0203],
    description:
      'SAR to purify for each share held for the whole year. Not a percentage. Zero is a real rate; `null` means ' +
      'none was published, and is never the same as zero.',
  }),
  status: StatusSchema,
}).annotate({ identifier: 'CompanyYear' });

export const CompanyDetailSchema = Schema.Struct({
  ...companyFields,
  years: Schema.Array(CompanyYearSchema).annotate({
    description: 'Every year with a rate or a status, in ascending order.',
  }),
}).annotate({ identifier: 'CompanyDetail', description: 'The company, with its status and rate for each year.' });

export const RateSchema = Schema.Struct({
  ticker: companyFields.ticker,
  name: companyFields.name,
  year: Schema.Int.annotate({ examples: [2023], description: 'Financial year of the annual statements.' }),
  ratePerShare: Schema.Number.annotate({
    examples: [0.0203],
    description: 'SAR to purify for each share held for the whole year. Not a percentage. Zero is a real rate.',
  }),
  status: StatusSchema,
}).annotate({ identifier: 'Rate', description: "The company's published rate and status for one year." });


export interface Coverage {
  startDay: number;
  endDay: number;
  startIso: string;
  endIso: string;
  firstYear: number;
  lastYear: number;
}

export const coverageOf = (dataset: LoadedDataset): Coverage => ({
  startDay: parseIsoDate(dataset.coverage.start)!,
  endDay: parseIsoDate(dataset.coverage.end)!,
  startIso: dataset.coverage.start,
  endIso: dataset.coverage.end,
  firstYear: dataset.years[0]!,
  lastYear: dataset.years.at(-1)!,
});

export const calculationEntrySchema = (coverage: Coverage) =>
  Schema.Struct({
    ticker: PositiveIntSchema.annotate({ examples: [2330], description: 'Tadawul ticker of the company.' }),
    shares: Schema.Finite.check(Schema.isGreaterThan(0), Schema.isLessThanOrEqualTo(1e12)).annotate({
      examples: [100],
      description: 'Number of shares held, more than 0 and at most 10^12. Fractions are allowed.',
    }),
    purchaseDate: Schema.optionalKey(
      Schema.String.annotate({
        examples: ['2021-03-01'],
        description: `Date mode. The day the shares were bought, as YYYY-MM-DD, from ${coverage.startIso} to ${coverage.endIso}. That day is counted.`,
      }),
    ),
    saleDate: Schema.optionalKey(
      Schema.String.annotate({
        examples: ['2023-06-30'],
        description: `Date mode. The day the shares were sold, as YYYY-MM-DD, after \`purchaseDate\` and no later than ${coverage.endIso}. That day is not counted. Omit it when \`stillOwned\` is true.`,
      }),
    ),
    stillOwned: Schema.optionalKey(
      Schema.Boolean.annotate({
        description: `Date mode. \`true\` when the shares are still held. The holding then runs until ${coverage.endIso}, the last day of the data, not until today, and that day is not counted.`,
      }),
    ),
    year: Schema.optionalKey(
      Schema.Int.annotate({
        examples: [2022],
        description: `Days mode. The year the holding started, from ${coverage.firstYear} to ${coverage.lastYear}. Use it with \`daysOwned\`.`,
      }),
    ),
    daysOwned: Schema.optionalKey(
      PositiveIntSchema.annotate({
        examples: [200],
        description: 'Days mode. How many days the shares were held. They are cut into consecutive 365-day years starting at `year`, and leap days are not counted.',
      }),
    ),
  })
    .check(
      Schema.makeFilter((entry) => {
        const issue = (path: string, message: string) => ({ path: [path], issue: message });

        const isDateMode = entry.purchaseDate !== undefined || entry.saleDate !== undefined || entry.stillOwned !== undefined;
        const isDaysMode = entry.year !== undefined || entry.daysOwned !== undefined;

        if (isDateMode === isDaysMode) {
          return issue(
            isDateMode ? 'year' : 'purchaseDate',
            'Give either `purchaseDate` (with `saleDate` or `stillOwned`) or `year` with `daysOwned`, not both or neither.',
          );
        }

        if (isDaysMode) {
          if (entry.year === undefined) return issue('year', '`year` is required with `daysOwned`.');
          if (entry.daysOwned === undefined) return issue('daysOwned', '`daysOwned` is required with `year`.');
          if (entry.year < coverage.firstYear || entry.year > coverage.lastYear) {
            return issue('year', `\`year\` must be between ${coverage.firstYear} and ${coverage.lastYear}.`);
          }
          const maxDays = (coverage.lastYear - entry.year + 1) * 365;
          if (entry.daysOwned > maxDays) {
            return issue('daysOwned', `Starting in ${entry.year}, \`daysOwned\` cannot exceed ${maxDays} (data ends in ${coverage.lastYear}).`);
          }
          return undefined;
        }

        if (entry.purchaseDate === undefined) return issue('purchaseDate', '`purchaseDate` is required in date mode.');
        const purchase = parseIsoDate(entry.purchaseDate);
        if (purchase === null) return issue('purchaseDate', '`purchaseDate` must be a real date in YYYY-MM-DD form.');
        if (purchase < coverage.startDay || purchase > coverage.endDay) {
          return issue('purchaseDate', `\`purchaseDate\` must be between ${coverage.startIso} and ${coverage.endIso}.`);
        }

        let end = coverage.endDay;
        if (entry.stillOwned) {
          if (entry.saleDate !== undefined) return issue('saleDate', 'Omit `saleDate` when `stillOwned` is true.');
        } else {
          if (entry.saleDate === undefined) return issue('saleDate', '`saleDate` is required unless `stillOwned` is true.');
          const sale = parseIsoDate(entry.saleDate);
          if (sale === null) return issue('saleDate', '`saleDate` must be a real date in YYYY-MM-DD form.');
          if (sale > coverage.endDay) {
            return issue('saleDate', `\`saleDate\` cannot be after ${coverage.endIso}; use \`stillOwned\` for a holding still open.`);
          }
          end = sale;
        }

        if (end <= purchase) {
          return issue(entry.stillOwned ? 'purchaseDate' : 'saleDate', 'The sale date must be after the purchase date.');
        }
        return undefined;
      }),
    )
    .annotate({ identifier: 'CalculationEntry' });

export type CalculationEntry = ReturnType<typeof calculationEntrySchema>['Type'];

export const calculationRequestSchema = (coverage: Coverage) =>
  Schema.Struct({
    entries: Schema.Array(calculationEntrySchema(coverage)).check(
      Schema.isMinLength(1),
      Schema.isMaxLength(MAX_ENTRIES_PER_REQUEST),
    ),
  }).annotate({
    identifier: 'CalculationRequest',
    description: `1 to ${MAX_ENTRIES_PER_REQUEST} holdings. Give each one either date mode or days mode, not both.`,
    examples: [
      {
        entries: [
          { ticker: 2330, shares: 100, purchaseDate: '2021-03-01', saleDate: '2023-06-30' },
          { ticker: 2222, shares: 10, purchaseDate: '2023-01-01', stillOwned: true },
          { ticker: 2001, shares: 50, year: 2022, daysOwned: 200 },
        ],
      },
    ],
  });

export const CalculationYearSchema = Schema.Struct({
  year: Schema.Int.annotate({ description: 'Calendar year of this part of the holding.' }),
  daysOwned: Schema.Int.annotate({ description: 'Days counted in this year.' }),
  ratePerShare: Schema.Number.annotate({ description: "The year's rate: SAR per share for a full year." }),
  status: StatusSchema,
  purificationAmount: Schema.Number.annotate({
    description: '`shares × ratePerShare × daysOwned / 365`, in SAR, rounded to 10 decimal places.',
  }),
}).annotate({ identifier: 'CalculationYear', description: 'One calendar year of a holding.' });

export const CalculationResponseSchema = Schema.Struct({
  currency: Schema.Literal('SAR').annotate({ description: 'Always `SAR`.' }),
  totalPurificationAmount: Schema.Number.annotate({
    description: 'The amount to purify for all entries, in SAR: the sum of every yearly amount, rounded to 10 decimal places.',
  }),
  entries: Schema.Array(
    Schema.Struct({
      index: Schema.Int.annotate({ description: 'Position of the entry in the request.' }),
      ticker: Schema.Int.annotate({ description: 'Tadawul ticker.' }),
      companyName: Schema.String.annotate({ description: 'Arabic name.' }),
      shares: Schema.Number.annotate({ description: 'Shares held, as sent.' }),
      purificationAmount: Schema.Number.annotate({
        description: "The entry's amount in SAR: the sum of its yearly amounts, rounded to 10 decimal places.",
      }),
      years: Schema.Array(CalculationYearSchema).annotate({ description: 'The holding, split into calendar years.' }),
    }),
  ).annotate({ description: 'One result per entry, in request order.' }),
}).annotate({ identifier: 'CalculationResponse', description: 'The amount to purify, in total, by entry and by year, in SAR.' });


export const MetaSchema = Schema.Struct({
  apiVersion: Schema.String.annotate({ description: 'Version of the API.' }),
  dataVersion: Schema.String.annotate({
    description: 'Changes whenever the data does. Every `/v1` response carries it as `X-Data-Version`.',
  }),
  coverage: Schema.Struct({
    start: Schema.String.annotate({ examples: ['2015-01-01'], description: 'First day the data covers.' }),
    end: Schema.String.annotate({
      examples: ['2025-12-31'],
      description: 'Last day the data covers. Calculations do not go past it.',
    }),
    years: Schema.Array(Schema.Int).annotate({ description: 'Years the data covers.' }),
  }),
  unit: Schema.String.annotate({ description: 'The unit of `ratePerShare`.' }),
  formula: Schema.String.annotate({ description: 'The formula a calculation applies to each calendar year.' }),
  companyCount: Schema.Int.annotate({ description: 'Number of companies the API serves.' }),
  unresolvedTickers: Schema.Array(Schema.Int).annotate({
    description: 'Tickers the source gives to more than one company. Any request that uses one gets `409 AMBIGUOUS_TICKER`.',
  }),
  rateLimit: Schema.Struct({
    requestsPerMinute: Schema.Int.annotate({ description: 'Requests allowed per minute for each IP address on `/v1`.' }),
  }),
  maxEntriesPerRequest: Schema.Int.annotate({ description: 'Most entries one calculation can have.' }),
}).annotate({ identifier: 'Meta', description: 'What the data covers, its version, and the request limits.' });

export const HealthSchema = Schema.Struct({ status: Schema.Literal('ok') }).annotate({ description: 'The service is up.' });
