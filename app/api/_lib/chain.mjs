// Read-only view of the pilot contracts on Rootstock testnet (or a local fork in development).
import { ethers } from "ethers";

const JOB_ABI = ["function getJob(uint256 jobId) view returns ((address client, address provider, address evaluator, uint256 escrow, uint64 expiredAt, uint64 submittedAt, uint8 state, bool hashedOnChain, bytes32 specHash, bytes32 deliverable, bytes32 reason))"];
const EV_ABI = ["function job() view returns (address)", "function reviewer() view returns (address)", "function specHashFor(bytes32 checklistDocHash, uint256 items) view returns (bytes32)"];

export function rpcChain(rpcUrl) {
  const provider = new ethers.JsonRpcProvider(rpcUrl, 31, { staticNetwork: true });
  return {
    async getJob(escrow, id) {
      const j = await new ethers.Contract(escrow, JOB_ABI, provider).getJob(BigInt(id));
      return { client: j.client, provider: j.provider, evaluator: j.evaluator, escrow: j.escrow, state: Number(j.state), specHash: j.specHash, deliverable: j.deliverable };
    },
    async specHashFor(evaluator, checklistHash, n) { return new ethers.Contract(evaluator, EV_ABI, provider).specHashFor(checklistHash, n); },
    async evaluatorInfo(evaluator) {
      const ev = new ethers.Contract(evaluator, EV_ABI, provider);
      const [job, reviewer] = await Promise.all([ev.job(), ev.reviewer()]);
      return { job, reviewer };
    },
  };
}
