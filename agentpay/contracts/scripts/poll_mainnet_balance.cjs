// Watch MAINNET balance of the AgentPay deployer (chain 1990).
// Exit 0 = funded -> run the deploy pipeline. Exit 1 = not funded yet.
// Usage: node scripts/poll_mainnet_balance.cjs
const ethers = require('ethers');

const DEPLOYER = '0x33E00d801943D945DC5Ec92A2192425427023586';
const RPCS = [
  'https://rpc1mainnet.qie.digital/',
  'https://rpc2mainnet.qie.digital/',
];

(async () => {
  for (const rpc of RPCS) {
    try {
      const provider = new ethers.JsonRpcProvider(rpc);
      const net = await provider.getNetwork();
      const bal = await provider.getBalance(DEPLOYER);
      console.log(`rpc: ${rpc}`);
      console.log(`chain: ${net.chainId}`);
      console.log(`deployer: ${DEPLOYER}`);
      console.log(`balance: ${ethers.formatEther(bal)} QIE`);
      if (bal > 0n) {
        console.log('FUNDED! -> run the deploy pipeline now:');
        console.log('  npx hardhat run scripts/deploy.ts --network qieMainnet');
        process.exit(0);
      }
      console.log('not funded yet.');
      process.exit(1);
    } catch (e) {
      console.log(`rpc ${rpc} failed: ${String(e.message || e).slice(0, 120)} — trying next...`);
    }
  }
  console.log('all rpcs failed');
  process.exit(2);
})();
