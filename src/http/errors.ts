import { Effect, Schema } from 'effect';
import type { LoadedDataset } from '../data/dataset.ts';
import type { UnresolvedTicker } from '../data/schema.ts';

// Errors are response bodies with HTTP status annotations. Omit absent details;
// the API cannot encode `details: undefined`.
export const errorBody = <Code extends string>(code: Code, ar: string, en: string, details?: unknown) => ({
  error: { code, message: { ar, en }, ...(details === undefined ? {} : { details }) },
});

const errorFields = <Code extends string>(code: Code) => ({
  error: Schema.Struct({
    code: Schema.Literal(code),
    message: Schema.Struct({ ar: Schema.String, en: Schema.String }),
    details: Schema.optionalKey(Schema.Unknown),
  }),
});

type Where = { entryIndex: number };

export class UnknownTicker extends Schema.Error<UnknownTicker>('UnknownTicker')(errorFields('UNKNOWN_TICKER'), {
  httpApiStatus: 404,
  description: '`UNKNOWN_TICKER`: no company with this ticker is in the data. `details` has `ticker`, and `entryIndex` in a calculation.',
}) {
  static of(ticker: number, where?: Where) {
    return new UnknownTicker(
      errorBody(
        'UNKNOWN_TICKER',
        `لا توجد شركة برمز ${ticker} في قاعدة البيانات.`,
        `No company with ticker ${ticker} is in the database.`,
        { ticker, ...where },
      ),
    );
  }
}

export class AmbiguousTicker extends Schema.Error<AmbiguousTicker>('AmbiguousTicker')(errorFields('AMBIGUOUS_TICKER'), {
  httpApiStatus: 409,
  description:
    '`AMBIGUOUS_TICKER`: the source gives this ticker to more than one company. `details` has `ticker`, the ' +
    '`candidates` names, and `entryIndex` in a calculation.',
}) {
  static of(entry: UnresolvedTicker, where?: Where) {
    return new AmbiguousTicker(
      errorBody(
        'AMBIGUOUS_TICKER',
        `الرمز ${entry.ticker} مرتبط بأكثر من شركة في البيانات، لذا لا يمكن تحديد الشركة المقصودة.`,
        `Ticker ${entry.ticker} maps to more than one company in the data, so it cannot be resolved.`,
        { ticker: entry.ticker, candidates: entry.candidates.map((candidate) => candidate.name), ...where },
      ),
    );
  }
}

export class RateNotAvailable extends Schema.Error<RateNotAvailable>('RateNotAvailable')(
  errorFields('RATE_NOT_AVAILABLE'),
  {
    httpApiStatus: 404,
    description:
      '`RATE_NOT_AVAILABLE`: no rate is published for that company and year. `details` has `ticker`, `year`, and ' +
      '`entryIndex` in a calculation.',
  },
) {
  static of(ticker: number, companyName: string, year: number, where?: Where) {
    return new RateNotAvailable(
      errorBody(
        'RATE_NOT_AVAILABLE',
        `نسبة التطهير لشركة ${companyName} في السنة ${year} غير متوفرة.`,
        `No purification rate is published for ${companyName} in ${year}.`,
        { ticker, year, ...where },
      ),
    );
  }
}

// Enough to fix a request by, and keeps a small body from earning a large error.
export const MAX_ISSUES = 20;

export class ValidationError extends Schema.Error<ValidationError>('ValidationError')(errorFields('VALIDATION_ERROR'), {
  httpApiStatus: 400,
  description: `\`VALIDATION_ERROR\`: the request is invalid. \`details\` lists up to ${MAX_ISSUES} \`{ path, message }\` items, and is absent when the body is not valid JSON.`,
}) {
  static of(issues: { path: string; message: string }[]) {
    return new ValidationError(
      errorBody(
        'VALIDATION_ERROR',
        'الطلب غير صالح. راجع الحقول المذكورة في التفاصيل.',
        'The request is invalid. See `details` for the offending fields.',
        issues.slice(0, MAX_ISSUES),
      ),
    );
  }

  static unparsable() {
    return new ValidationError(
      errorBody(
        'VALIDATION_ERROR',
        'تعذّر قراءة جسم الطلب. أرسل JSON صالحًا مع الترويسة Content-Type: application/json.',
        'The request body could not be parsed. Send valid JSON with Content-Type: application/json.',
      ),
    );
  }
}

export class PayloadTooLarge extends Schema.Error<PayloadTooLarge>('PayloadTooLarge')(errorFields('PAYLOAD_TOO_LARGE'), {
  httpApiStatus: 413,
  description: '`PAYLOAD_TOO_LARGE`: the body is over 100 KiB. Split the holdings across requests.',
}) {
  static of() {
    return new PayloadTooLarge(
      errorBody('PAYLOAD_TOO_LARGE', 'حجم الطلب أكبر من المسموح (100 كيلوبايت).', 'Request body exceeds 100 KB.'),
    );
  }
}

export class RateLimited extends Schema.Error<RateLimited>('RateLimited')(errorFields('RATE_LIMITED'), {
  httpApiStatus: 429,
  description: '`RATE_LIMITED`: too many requests from this IP address. Retry after the seconds in `Retry-After`.',
}) {
  static of(limit: number, secondsUntilReset: number) {
    return new RateLimited(
      errorBody(
        'RATE_LIMITED',
        `تجاوزت الحد المسموح (${limit} طلبًا في الدقيقة). حاول مجددًا بعد ${secondsUntilReset} ثانية.`,
        `Rate limit of ${limit} requests per minute exceeded. Retry in ${secondsUntilReset}s.`,
      ),
    );
  }
}

export const resolveCompany = Effect.fn('resolveCompany')(function* (
  dataset: LoadedDataset,
  ticker: number,
  where?: Where,
) {
  const lookup = dataset.lookup(ticker);
  if (lookup.kind === 'unknown') return yield* UnknownTicker.of(ticker, where);
  if (lookup.kind === 'unresolved') return yield* AmbiguousTicker.of(lookup.entry, where);
  return lookup.company;
});
