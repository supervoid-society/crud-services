declare module "cloudflare:test" {
  import { ExecutionContext } from "@cloudflare/workers-types";
  export const env: any;
  export function createExecutionContext(): ExecutionContext;
  export function waitOnExecutionContext(ctx: ExecutionContext): Promise<void>;
}
