import { readFileSync, writeFileSync } from 'fs';

const file = 'node_modules/@meteora-ag/dlmm/dist/index.mjs';
let content = readFileSync(file, 'utf-8');

// 1. Replace the initial BN import from anchor (with alias)
content = content.replace(
  /^import \{ BN as BN\d+ \} from "@coral-xyz\/anchor";/gm,
  '// BN imported from bn.js'
);

// 1b. Replace plain BN import from anchor
content = content.replace(
  /^import \{ BN \} from "@coral-xyz\/anchor";/gm,
  '// BN imported from bn.js'
);

// 2. Replace multi-line BN imports
content = content.replace(
  /import \{\s*\n\s*BN as BN\d+\s*\n\} from "@coral-xyz\/anchor";/g,
  '// BN imported from bn.js'
);

// 3. Replace BN in combined imports
content = content.replace(
  /import \{ AnchorProvider, BN as BN\d+, Program as Program2 \} from "@coral-xyz\/anchor";/g,
  'import { AnchorProvider, Program as Program2 } from "@coral-xyz/anchor";'
);

// 4. Add BN import from bn.js and all aliases at the top
const bnAliases = `import BN from 'bn.js';
const BN2 = BN;
const BN5 = BN;
const BN6 = BN;
const BN7 = BN;
const BN8 = BN;
const BN11 = BN;
const BN17 = BN;
const BN18 = BN;
const BN21 = BN;
`;

// Replace first line comment with our imports
content = content.replace(
  '// src/dlmm/index.ts\n',
  '// src/dlmm/index.ts\n' + bnAliases
);

// 5. Remove original BN21 import from anchor if it exists
content = content.replace(
  /import \{ BN as BN21 \} from "@coral-xyz\/anchor";\n?/g,
  ''
);

// 6. Replace direct BN imports from bn.js with aliases
content = content.replace(/import BN(\d+) from "bn\.js";/g, 'const BN$1 = BN; // from bn.js');

writeFileSync(file, content);
console.log('✅ Patched Meteora index.mjs');
