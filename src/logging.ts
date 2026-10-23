import { Effect, Layer, Logger } from 'effect';
import { FetchHttpClient } from 'effect/http';
import { OtlpLogger, OtlpSerialization } from 'effect/observability';
import { API_VERSION, IS_RENDER, OTLP_PROTOCOL } from './config.ts';

// Logs go to stdout, which Render keeps for a week: one JSON object per line
// on Render, Effect's readable format elsewhere.
//
// They are also exported over OTLP, for example to OpenObserve, once
// OTEL_LOGS_EXPORTER=otlp and OTEL_EXPORTER_OTLP_ENDPOINT are set. The export
// runs in the background in batches: a log backend that is down or refuses
// the logs loses those logs, never a request.
export const LoggingLayer = Layer.unwrap(
  Effect.gen(function* () {
    const stdout = (yield* IS_RENDER) ? Logger.layer([Logger.consoleJson]) : Layer.empty;
    const serialization = (yield* OTLP_PROTOCOL) === 'http/json' ? OtlpSerialization.layerJson : OtlpSerialization.layerProtobuf;

    const otlp = OtlpLogger.layerFromConfig({
      resource: { serviceName: 'naqua-api', serviceVersion: API_VERSION },
    }).pipe(Layer.provide([serialization, FetchHttpClient.layer]));

    // The OTLP logger joins whichever loggers `stdout` installed.
    return otlp.pipe(Layer.provideMerge(stdout));
  }),
);
