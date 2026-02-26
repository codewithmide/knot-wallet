const fs = require('fs');
const path = require('path');

// Find and patch the Meteora index.ts file
const meteoraFile = path.join(__dirname, 'node_modules/@meteora-ag/dlmm/src/dlmm/constants/index.ts');

if (fs.existsSync(meteoraFile)) {
  let content = fs.readFileSync(meteoraFile, 'utf-8');
  
  // Replace the problematic import
  if (content.includes("import { BN } from \"@coral-xyz/anchor\";")) {
    content = content.replace(
      "import { BN } from \"@coral-xyz/anchor\";",
      "import BN from \"bn.js\";"
    );
    fs.writeFileSync(meteoraFile, content, 'utf-8');
    console.log('✓ Patched Meteora imports');
  } else {
    console.log('BN import not found in expected location, checking other files...');
  }
} else {
  console.log('Meteora file not found at:', meteoraFile);
}
