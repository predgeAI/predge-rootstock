// Vercel Function: the private case record (see app/api/_lib/handler.mjs).
// Env: BLOB_READ_WRITE_TOKEN (private Blob store connected to this project), optional RSK_RPC,
// PILOT_ESCROW / PILOT_EVALUATOR (default: the Rootstock testnet USDRIF pilot contracts).
import { createHandler } from "./_lib/handler.mjs";
import { storeFromEnv } from "./_lib/store.mjs";
import { rpcChain } from "./_lib/chain.mjs";

export const DEFAULTS = {
  rpc: "https://public-node.testnet.rsk.co",
  escrow: "0x15C790fb445dc8Ed00aca65e424e26CDeB1999A0",
  evaluator: "0xca4E20f5903f795374B96331011Aaa24C45f6316",
};

let handlerP;
function handler() {
  handlerP ??= storeFromEnv().then((store) => createHandler({
    store,
    chain: rpcChain(process.env.RSK_RPC || DEFAULTS.rpc),
    config: { escrow: process.env.PILOT_ESCROW || DEFAULTS.escrow, evaluator: process.env.PILOT_EVALUATOR || DEFAULTS.evaluator },
  }));
  return handlerP;
}

export async function GET(request) { return (await handler())(request); }
export async function POST(request) { return (await handler())(request); }
