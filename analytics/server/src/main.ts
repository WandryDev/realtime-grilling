// The analytics server: `PORT` (8787) on `HOST` (127.0.0.1: the server has
// no sign-in, so it answers only where it is put — an internal network or
// the company's VPN; spec «Только внутренняя сеть»), the database at
// `DATABASE_URL`.

import { BunHttpServer, BunRuntime } from "@effect/platform-bun";
import { Layer } from "effect";
import { HttpRouter } from "effect/http";
import { layerPostgres } from "./db";
import { ApiRoutes, Services } from "./http";
import { WebRoutes } from "./web";

const port = Number(process.env.PORT ?? 8787);
const hostname = process.env.HOST ?? "127.0.0.1";

const Server = HttpRouter.serve(Layer.mergeAll(ApiRoutes, WebRoutes)).pipe(
  Layer.provide(Services),
  Layer.provide(layerPostgres),
  Layer.provide(BunHttpServer.layer({ hostname, port }))
);

Layer.launch(Server).pipe(BunRuntime.runMain);
