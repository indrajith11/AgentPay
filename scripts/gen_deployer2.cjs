const ethers = require('/home/z/my-project/agentpay/contracts/node_modules/ethers');
const fs = require('fs');
const w = ethers.Wallet.createRandom();
const prev = JSON.parse(fs.readFileSync('/home/z/my-project/agentpay/contracts/.env.testnet-deployer.json','utf8'));
const out = { ...prev, backupAddress: w.address, backupPrivateKey: w.privateKey, note: 'TESTNET ONLY - primary + backup faucet claim' };
fs.writeFileSync('/home/z/my-project/agentpay/contracts/.env.testnet-deployer.json', JSON.stringify(out, null, 2));
console.log('backup address:', w.address);
