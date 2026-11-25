// LOCAL FORK TESTING ONLY. Loaded by pilot.js only when the page runs on localhost with ?devwallet=<n>.
// Injects an EIP-1193 provider that forwards to anvil, whose dev accounts are unlocked: anvil signs the
// transactions and EIP-712 signatures itself. No private key is held by the page. On any other host this
// file is never imported.
export async function install(rpc, index) {
  let id = 0;
  const call = async (method, params = []) => {
    const r = await fetch(rpc, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: ++id, method, params }) });
    const j = await r.json();
    if (j.error) throw Object.assign(new Error(j.error.message), { code: j.error.code, data: j.error.data });
    return j.result;
  };
  const accounts = await call("eth_accounts");
  const me = accounts[index];
  if (!me) throw new Error(`dev wallet: anvil has no account #${index}`);
  window.ethereum = {
    isDevWallet: true,
    async request({ method, params }) {
      switch (method) {
        case "eth_requestAccounts": case "eth_accounts": return [me];
        case "eth_chainId": return "0x1f";
        case "wallet_switchEthereumChain": case "wallet_addEthereumChain": return null;
        default: return call(method, params || []);
      }
    },
    on() {}, removeListener() {},
  };
}
