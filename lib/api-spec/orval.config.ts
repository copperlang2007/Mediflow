import { defineConfig, InputTransformerFn } from "orval";
import path from "path";

const root = path.resolve(__dirname, "..", "..");
const apiClientReactSrc = path.resolve(root, "lib", "api-client-react", "src");
const apiZodSrc = path.resolve(root, "lib", "api-zod", "src");

const titleTransformer: InputTransformerFn = (config) => {
  config.info ??= {};
  config.info.title = "Api";
  return config;
};

export default defineConfig({
  "api-client-react": {
    input: {
      target: "./openapi.yaml",
      override: {
        transformer: titleTransformer,
      },
    },
    output: {
      workspace: apiClientReactSrc,
      target: "generated",
      client: "react-query",
      mode: "split",
      baseUrl: "/api",
      clean: true,
      prettier: true,
      override: {
        fetch: {
          includeHttpResponseReturnType: false,
        },
        mutator: {
          path: path.resolve(apiClientReactSrc, "custom-fetch.ts"),
          name: "customFetch",
        },
      },
    },
  },
  zod: {
    input: {
      target: "./openapi.yaml",
      override: {
        transformer: titleTransformer,
      },
    },
    output: {
      workspace: apiZodSrc,
      client: "zod",
      target: "generated/api.ts",
      clean: true,
      prettier: true,
      override: {
        zod: {
          // Pin the Zod output target rather than leaving it on `auto`.
          //
          // orval >=8.22 infers the target from the zod version it resolves,
          // and falls back to Zod 4 output when detection is ambiguous. This
          // workspace is on zod ^3.25.76 (see the pnpm catalog), so an
          // inferred Zod 4 target emits `z.int()` / `z.email()` — top-level
          // helpers that do not exist in the v3 root API — and the generated
          // client fails to typecheck.
          //
          // Pinning makes codegen deterministic: the output depends on this
          // file, not on whatever zod happens to be hoisted at generation
          // time. Change this to 4 in the same commit that moves the catalog
          // to zod 4.
          version: 3,
          coerce: {
            query: ["boolean", "number", "string"],
            param: ["boolean", "number", "string"],
            body: ["bigint", "date"],
            response: ["bigint", "date"],
          },
        },
        useDates: true,
        useBigInt: true,
      },
    },
  },
});
