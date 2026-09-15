// Poll testnet balance for deployer + backup wallets; exit 0 when funded
const ethers = require('ethers');
const fs = require('fs');
const d = JSON.parse(fs.readFileSync('.env.testnet-deployer.json', 'utf8'));
const provider = new ethers.JsonRpcProvider('https://rpc1testnet.qie.digital/');
const targets = [[d.address, d.privateKey], [d.backupAddress, d.backupPrivateKey]];
(async () => {
  for (const [addr] of targets) {
    const bal = await provider.getBalance(addr);
    console.log(addr, ethers.formatEther(bal), 'QIE');
    if (bal > 0n) {
      console.log('FUNDED:', addr);
      process.exit(0);
    }
  }
  console.log('not funded yet — rerun: node scripts/poll_balance.cjs');
  process.exit(1);
})();
