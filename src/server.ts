import * as NodeHttpServer from '@effect/platform-node/NodeHttpServer';
import * as NodeRuntime from '@effect/platform-node/NodeRuntime';
import { Layer } from 'effect';
import { HttpRouter } from 'effect/http';
import { createServer } from 'node:http';
import { AppLayer } from './app.ts';
import { PORT } from './config.ts';
import { Dataset } from './data/dataset.ts';
import { LoggingLayer } from './logging.ts';

// The router middleware logs each request itself, so Effect's own request log is off.
const ServerLayer = HttpRouter.serve(AppLayer, { disableLogger: true }).pipe(
  Layer.provide(NodeHttpServer.layerConfig(createServer, { port: PORT })),
  Layer.provide(Dataset.layer),
  Layer.provide(LoggingLayer),
);

NodeRuntime.runMain(Layer.launch(ServerLayer));
