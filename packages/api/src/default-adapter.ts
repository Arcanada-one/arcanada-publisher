// Lazy default adapter factory. The live adapters (facebook / linkedin / x /
// reddit / vkontakte) are heavy browser/API packages; importing them eagerly
// would (a) pull Playwright into every consumer of the server module and (b)
// make the server package's test graph depend on packages it does not need for
// route-dispatch tests. So the real factory is dynamically imported on first
// adapter method call. Tests inject their own `makeAdapter`, so this path is
// only exercised in production (CLI `server` command).

import { type Adapter, type Platform } from "@arcanada/publisher-core";

/** A platform-bound Adapter that defers construction to the first method call. */
function lazyAdapter(platform: Platform, auditBaseDir?: string): Adapter {
  let real: Promise<Adapter> | undefined;
  const resolve = (): Promise<Adapter> => {
    real ??= import("./adapter-factory.js").then((m) =>
      m.makeAdapter(platform, false, auditBaseDir),
    );
    return real;
  };
  return {
    platform,
    login: async (o) => (await resolve()).login(o),
    publish: async (i) => (await resolve()).publish(i),
    comment: async (i) => (await resolve()).comment(i),
    edit: async (i) => (await resolve()).edit(i),
    delete: async (i) => (await resolve()).delete(i),
    verify: async (u) => (await resolve()).verify(u),
  };
}

/** Default factory used when the server is started without an injected one. */
export function defaultMakeAdapter(platform: Platform, auditBaseDir?: string): Adapter {
  return lazyAdapter(platform, auditBaseDir);
}
