import { Schema } from 'effect';
import type { LoadedDataset } from '../data/dataset.ts';
import { STATUSES } from '../data/schema.ts';
import { parseIsoDate } from '../domain/dates.ts';

export const MAX_ENTRIES_PER_REQUEST = 100;


export const StatusSchema = Schema.NullOr(Schema.Literals(STATUSES)).annotate({
  identifier: 'Status',
  description:
    'Shariah classification for the year: `pure` (نقية), `mixed` (مختلطة), `non-pure` (غير متوافقة), or ' +
    '`public-sector` (القطاع العام — state-owned, treated as permissible). Null when the source does not say.',
});

const PositiveIntSchema = Schema.Int.check(Schema.isGreaterThan(0));

export const TickerParams = { ticker: PositiveIntSchema.annotate({ examples: [2330] }) };
export const RateParams = { ...TickerParams, year: Schema.Int.annotate({ examples: [2023] }) };


const companyFields = {
  ticker: Schema.Int.annotate({ examples: [2330], description: 'Tadawul ticker.' }),
  name: Schema.String.annotate({ examples: ['المتقدمة'], description: 'Arabic name.' }),
  aliases: Schema.Array(Schema.String).annotate({ examples: [[]], description: 'Former or alternative Arabic names.' }),
  overallStatus: Schema.NullOr(Schema.Literals([...STATUSES, 'varies'])).annotate({
    description: 'The status if it was the same in every year with a known status, `varies` if it changed.',
  }),
};

export const CompanySummarySchema = Schema.Struct({
  ...companyFields,
  availableYears: Schema.Array(Schema.Int).annotate({
    examples: [[2022, 2023, 2024]],
    description: 'Years with a published rate.',
  }),
}).annotate({ identifier: 'CompanySummary' });

export const CompanyListSchema = Schema.Struct({
  count: Schema.Int,
  companies: Schema.Array(CompanySummarySchema),
}).annotate({ identifier: 'CompanyList', description: 'All companies, sorted by ticker, with the years that have a rate.' });

export const CompanyYearSchema = Schema.Struct({
  year: Schema.Int.annotate({ examples: [2023] }),
  ratePerShare: Schema.NullOr(Schema.Number).annotate({
    examples: [0.0203],
    description: 'SAR to purify per share held for the whole year. Null when none was published.',
  }),
  status: StatusSchema,
}).annotate({ identifier: 'CompanyYear' });

export const CompanyDetailSchema = Schema.Struct({
  ...companyFields,
  years: Schema.Array(CompanyYearSchema),
}).annotate({ identifier: 'CompanyDetail', description: 'The company and everything known about each year.' });

export const RateSchema = Schema.Struct({
  ticker: companyFields.ticker,
  name: companyFields.name,
  year: Schema.Int.annotate({ examples: [2023] }),
  ratePerShare: Schema.Number.annotate({ examples: [0.0203] }),
  status: StatusSchema,
}).annotate({ identifier: 'Rate', description: 'The rate.' });


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
    ticker: PositiveIntSchema.annotate({ examples: [2330] }),
    shares: Schema.Finite.check(Schema.isGreaterThan(0), Schema.isLessThanOrEqualTo(1e12)).annotate({
      examples: [100],
      description: 'Number of shares held.',
    }),
    purchaseDate: Schema.optionalKey(
      Schema.String.annotate({
        examples: ['2021-03-01'],
        description: `Date mode. YYYY-MM-DD, between ${coverage.startIso} and ${coverage.endIso}.`,
      }),
    ),
    saleDate: Schema.optionalKey(
      Schema.String.annotate({
        examples: ['2023-06-30'],
        description: 'Date mode. After `purchaseDate`; the sale day itself is not counted. Omit when `stillOwned` is true.',
      }),
    ),
    stillOwned: Schema.optionalKey(
      Schema.Boolean.annotate({
        description: `Date mode. The holding runs until ${coverage.endIso}, the last day of the data, which like a sale day is not counted.`,
      }),
    ),
    year: Schema.optionalKey(
      Schema.Int.annotate({
        examples: [2022],
        description: `Days mode. The year the holding started (${coverage.firstYear}–${coverage.lastYear}).`,
      }),
    ),
    daysOwned: Schema.optionalKey(
      PositiveIntSchema.annotate({
        examples: [200],
        description: 'Days mode. Split into consecutive 365-day years starting at `year`; leap days are not observed.',
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
  year: Schema.Int,
  daysOwned: Schema.Int,
  ratePerShare: Schema.Number,
  status: StatusSchema,
  purificationAmount: Schema.Number.annotate({ description: 'SAR, to 10 decimal places.' }),
}).annotate({ identifier: 'CalculationYear' });

export const CalculationResponseSchema = Schema.Struct({
  currency: Schema.Literal('SAR'),
  totalPurificationAmount: Schema.Number,
  entries: Schema.Array(
    Schema.Struct({
      index: Schema.Int.annotate({ description: 'Position of the entry in the request.' }),
      ticker: Schema.Int,
      companyName: Schema.String,
      shares: Schema.Number,
      purificationAmount: Schema.Number,
      years: Schema.Array(CalculationYearSchema),
    }),
  ),
}).annotate({ identifier: 'CalculationResponse', description: 'The per-year breakdown and total, in SAR.' });


export const MetaSchema = Schema.Struct({
  apiVersion: Schema.String,
  dataVersion: Schema.String.annotate({ description: 'Changes whenever the underlying data does.' }),
  coverage: Schema.Struct({
    start: Schema.String.annotate({ examples: ['2015-01-01'] }),
    end: Schema.String.annotate({ examples: ['2025-12-31'] }),
    years: Schema.Array(Schema.Int),
  }),
  unit: Schema.String,
  formula: Schema.String,
  companyCount: Schema.Int,
  unresolvedTickers: Schema.Array(Schema.Int).annotate({
    description: 'Tickers the data assigns to more than one company; lookups on them return 409.',
  }),
  rateLimit: Schema.Struct({ requestsPerMinute: Schema.Int }),
  maxEntriesPerRequest: Schema.Int,
}).annotate({ identifier: 'Meta', description: 'Metadata.' });

export const HealthSchema = Schema.Struct({ status: Schema.Literal('ok') }).annotate({ description: 'The service is up.' });
