// Generate a dedicated testnet deployer wallet (never holds real funds)
const ethers = require('/home/z/my-project/agentpay/contracts/node_modules/ethers');
const fs = require('fs');
const w = ethers.Wallet.createRandom();
const out = { address: w.address, privateKey: w.privateKey, mnemonic: w.mnemonic.phrase, note: 'TESTNET ONLY - generated for QIE hackathon deployer' };
fs.writeFileSync('/home/z/my-project/agentpay/contracts/.env.testnet-deployer.json', JSON.stringify(out, null, 2));
console.log('address:', w.address);
